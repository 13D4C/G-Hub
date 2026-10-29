output "cluster_name" { value = aws_eks_cluster.main.name }
output "ecr_url" { value = aws_ecr_repository.app.repository_url }
output "bucket" { value = data.aws_s3_bucket.media.bucket }
output "alb_dns_name" { value = aws_lb.app.dns_name }
output "alb_url" { value = "http://${aws_lb.app.dns_name}" }
output "app_url" { value = "https://${var.app_domain}" }
