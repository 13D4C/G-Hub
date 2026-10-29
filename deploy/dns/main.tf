# The Route 53 zone for the app's hostname, kept apart from deploy/terraform on purpose.
#
# natthapong.net stays on Cloudflare, which hands just this one name to Route 53 with four NS
# records. Those records point at this zone's nameservers, and a zone gets new nameservers every
# time it is recreated. Living here, the zone survives `terraform destroy` of the app stack, so
# the Cloudflare side is set up once. It costs $0.50 a month.
#
#   terraform init && terraform apply
#   terraform output cloudflare_ns_records   # add these in Cloudflare
#
# deploy/terraform finds this zone by name and writes the app and certificate records into it.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# Credentials come from ~/.aws/credentials, as in deploy/terraform.
provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "g-hub" }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "app_domain" {
  description = "The name Cloudflare delegates to Route 53. Must match deploy/terraform's app_domain."
  type        = string
  default     = "clouddev.natthapong.net"
}

resource "aws_route53_zone" "app" {
  name    = var.app_domain
  comment = "Delegated from Cloudflare (natthapong.net); records are managed by deploy/terraform"

  # The app stack's records live in here; let a deliberate destroy of this stack take them along.
  force_destroy = true
}

output "zone_id" {
  value = aws_route53_zone.app.zone_id
}

output "name_servers" {
  value = aws_route53_zone.app.name_servers
}

# What to add in Cloudflare: four NS records, all named after the delegated label.
output "cloudflare_ns_records" {
  value = [
    for ns in aws_route53_zone.app.name_servers : "NS  ${trimsuffix(var.app_domain, ".natthapong.net")}  ->  ${ns}"
  ]
}
