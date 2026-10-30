# The zone belongs to dns/, which this stack never destroys: Cloudflare delegates the name to that
# zone's nameservers. This stack only writes the record pointing at the ALB, so it follows the
# ALB through every destroy and apply.
#
# If this lookup fails, apply dns/ first.
data "aws_route53_zone" "app" {
  name = var.app_domain
}

# An alias rather than a CNAME: it is allowed at the zone apex, which var.app_domain is, and it
# tracks the ALB's changing addresses with no TTL to wait out.
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
