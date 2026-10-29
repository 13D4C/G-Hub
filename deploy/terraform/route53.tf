# DNS for var.app_domain lives in a Route 53 zone created by deploy/dns, which this stack never
# destroys (Cloudflare delegates the name to that zone's nameservers). This stack only writes
# records into it, so they follow the ALB and the certificate through every destroy and apply.
#
# If this lookup fails, apply deploy/dns first.
data "aws_route53_zone" "app" {
  name = var.app_domain
}

# Points the hostname at the ALB. An alias record works at the zone apex, where a CNAME can't,
# and it tracks the ALB's addresses without a TTL to wait out.
resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.app.zone_id
  name    = var.app_domain
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = false
  }
}

# The CNAME that proves to ACM this account controls the name. ACM reuses the same record for
# the same name in the same account, so overwriting one left behind by an earlier apply is fine.
resource "aws_route53_record" "acm_validation" {
  for_each = {
    for o in aws_acm_certificate.app.domain_validation_options : o.domain_name => o
  }

  zone_id         = data.aws_route53_zone.app.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}
