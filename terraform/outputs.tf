output "region" {
  value = var.region
}

output "cluster_name" {
  value = aws_eks_cluster.main.name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.main.endpoint
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.app.repository_url
  description = "Push the image here; deploy.sh does it for you."
}

output "s3_bucket" {
  value = local.media_bucket
}

output "dynamodb_table_prefix" {
  value = local.table_prefix
}

output "app_url_override" {
  value       = var.app_url != "" ? var.app_url : "https://${var.app_domain}"
  description = "The origin deploy.sh writes into APP_URL and GOOGLE_REDIRECT_URI."
}

output "alb_dns_name" {
  value       = aws_lb.app.dns_name
  description = "What the Route 53 alias points at."
}

output "web_acl_name" {
  value = aws_wafv2_web_acl.app.name
}

output "session_secret" {
  value     = random_password.session_secret.result
  sensitive = true
}

output "stripe_secret_key" {
  value     = var.stripe_secret_key
  sensitive = true
}

output "stripe_webhook_secret" {
  value     = var.stripe_webhook_secret
  sensitive = true
}

output "google_client_id" {
  value     = var.google_client_id
  sensitive = true
}

output "google_client_secret" {
  value     = var.google_client_secret
  sensitive = true
}

output "web_replicas" {
  value = var.web_replicas
}

output "worker_replicas" {
  value = var.worker_replicas
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --name ${aws_eks_cluster.main.name} --region ${var.region}"
}
