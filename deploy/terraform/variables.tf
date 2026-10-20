variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  type    = string
  default = "g-hub"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "node_instance_type" {
  type    = string
  default = "t3.medium"
}

variable "node_count" {
  type    = number
  default = 2
}

variable "node_disk_size" {
  description = "Root volume of each node, in GiB."
  type        = number
  default     = 30
}

variable "app_domain" {
  description = "Public hostname of the app. Its DNS is in Cloudflare: a DNS-only CNAME to the ALB."
  type        = string
  default     = "clouddev.natthapong.net"
}

variable "lb_hostname" {
  description = "Load balancer DNS from kubectl (fill after first k8s deploy)."
  type        = string
  default     = ""
}
