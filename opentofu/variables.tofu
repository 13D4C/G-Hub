variable "project" {
  type        = string
  default     = "g-hub"
  description = "Name prefix and cost-allocation tag for every resource. Also the Kubernetes namespace, so changing it lets this stack stand beside the Terraform one."
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS Academy Learner Lab only grants us-east-1 and us-west-2."
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "az_count" {
  type        = number
  default     = 2
  description = "Availability zones to spread the subnets across."
}

variable "nat_per_az" {
  type        = bool
  default     = true
  description = <<-EOT
    true:  one NAT Gateway per availability zone, as in the architecture diagram.
           A zone losing its gateway does not take the other zone's nodes with it.
    false: a single NAT Gateway shared by both zones. Halves the ~$0.045/hour each
           one costs, at the price of that independence.
  EOT
}

variable "eks_version" {
  type    = string
  default = "1.30"
}

variable "node_instance_type" {
  type        = string
  default     = "t3.large"
  description = "The lab refuses anything above .large. The worker pod runs ffmpeg, so do not go below this."
}

variable "node_desired_size" {
  type    = number
  default = 2
}

variable "node_min_size" {
  type    = number
  default = 2
}

variable "node_max_size" {
  type    = number
  default = 4
}

variable "node_disk_size" {
  type        = number
  default     = 40
  description = "Gigabytes per node. Transcoding stages the source and its segments on disk."
}

variable "web_replicas" {
  type    = number
  default = 2
}

variable "worker_replicas" {
  type        = number
  default     = 1
  description = "Set to 0 to turn transcoding off entirely."
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Tag in the ECR repository that both deployments run."
}

variable "app_url" {
  type        = string
  default     = ""
  description = <<-EOT
    Public origin, e.g. https://g-hub.example.com. Empty uses the load balancer's
    own DNS name over HTTP, which is enough for email/password sign-in but not for
    Google OAuth: Google refuses any redirect URI that is not HTTPS.
  EOT
}

variable "stripe_secret_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Test-mode key only; the app rejects a live one."
}

variable "stripe_webhook_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "google_client_id" {
  type      = string
  default   = ""
  sensitive = true
}

variable "google_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}
