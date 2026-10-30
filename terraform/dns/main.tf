# The Route 53 zone and certificate for the app's hostname, kept apart from ../ on purpose.
#
# natthapong.net stays on Cloudflare, which hands just this one name to Route 53 with four NS
# records. Those records point at this zone's nameservers, and a zone gets new nameservers every
# time it is recreated. Living here, the zone survives ../destroy.sh, so the Cloudflare side is
# set up once. The certificate lives here for the same reason: ACM issues it once instead of
# making every apply of the app stack wait for validation. The zone costs $0.50 a month; the
# certificate is free.
#
# The zone already exists (created from the opt/tf-taikie branch, whose state is gone), so
# adopt it rather than letting apply create a second one with different nameservers:
#
#   terraform init
#   terraform import aws_route53_zone.app Z07930312B7411JSYYDQH
#   terraform output cloudflare_ns_records   # add these in Cloudflare first
#   terraform apply                          # waits until the certificate is issued
#
# ../ finds the zone and the certificate by name.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project = "g-hub"
    }
  }
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "Must match ../ — an ALB can only use a certificate from its own region."
}

variable "app_domain" {
  type        = string
  default     = "clouddev.natthapong.net"
  description = "The name Cloudflare delegates to Route 53. Must match app_domain in ../."
}

resource "aws_route53_zone" "app" {
  name    = var.app_domain
  comment = "Delegated from Cloudflare (natthapong.net); records are managed by terraform/"

  # The app stack's alias record lives in here; let a deliberate destroy of this stack take it along.
  force_destroy = true
}

resource "aws_acm_certificate" "app" {
  domain_name       = var.app_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# The certificate names a single domain, so it has exactly one validation option. Reading it with
# one() rather than a for_each keeps this record's address static: `terraform import` evaluates
# the whole configuration before the certificate exists, and a for_each keyed on its unknown
# options fails there.
locals {
  acm_validation = one(aws_acm_certificate.app.domain_validation_options)
}

# The CNAME that proves to ACM this account controls the name.
resource "aws_route53_record" "acm_validation" {
  zone_id         = aws_route53_zone.app.zone_id
  name            = local.acm_validation.resource_record_name
  type            = local.acm_validation.resource_record_type
  records         = [local.acm_validation.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

# Blocks until ACM sees the record above, which it only can once Cloudflare delegates the name.
resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [aws_route53_record.acm_validation.fqdn]

  timeouts {
    create = "45m"
  }
}

output "zone_id" {
  value = aws_route53_zone.app.zone_id
}

output "name_servers" {
  value = aws_route53_zone.app.name_servers
}

output "certificate_arn" {
  value = aws_acm_certificate_validation.app.certificate_arn
}

# What to add in Cloudflare: four NS records, all named after the delegated label.
output "cloudflare_ns_records" {
  value = [
    for ns in aws_route53_zone.app.name_servers : "NS  ${trimsuffix(var.app_domain, ".natthapong.net")}  ->  ${ns}"
  ]
}
