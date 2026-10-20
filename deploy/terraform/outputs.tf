output "cluster_name" { value = aws_eks_cluster.main.name }
output "ecr_url" { value = aws_ecr_repository.app.repository_url }
output "bucket" { value = data.aws_s3_bucket.media.bucket }
output "alb_dns_name" { value = aws_lb.app.dns_name }
output "alb_url" { value = "http://${aws_lb.app.dns_name}" }
output "app_url" { value = "https://${var.app_domain}" }

# Add these in Cloudflare as DNS-only (grey cloud) records:
#   1. the ACM validation CNAME below
#   2. CNAME  <app_domain>  ->  alb_dns_name
output "acm_validation" {
  value = [
    for o in aws_acm_certificate.app.domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}
