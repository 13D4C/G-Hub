# The public entry point. Terraform owns it rather than Kubernetes, so the WAF in waf.tf can be
# attached (WAF does not support the Classic ELB a `type: LoadBalancer` Service creates), Route 53
# can alias it, and `terraform destroy` removes it without leaving an orphan billing by the hour.
#
# The web Service is a NodePort (k8s/30-service.yaml); every node answers on it and forwards to a
# web pod, so the target group just registers the node group's instances.
locals {
  node_port = 30080
  node_sg   = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  node_asg  = aws_eks_node_group.main.resources[0].autoscaling_groups[0].name
}

# Issued once by dns/, which keeps it across destroys.
data "aws_acm_certificate" "app" {
  domain   = var.app_domain
  statuses = ["ISSUED"]
}

resource "aws_security_group" "alb" {
  name        = "${var.project}-alb"
  description = "Public HTTP and HTTPS to the ALB"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-alb" }
}

# The nodes carry the EKS cluster security group, since the launch template names none.
resource "aws_security_group_rule" "alb_to_nodes" {
  type                     = "ingress"
  from_port                = local.node_port
  to_port                  = local.node_port
  protocol                 = "tcp"
  security_group_id        = local.node_sg
  source_security_group_id = aws_security_group.alb.id
  description              = "ALB to the web NodePort"
}

resource "aws_lb" "app" {
  name               = var.project
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  # Uploads are buffered whole before the app answers, and the old Classic ELB allowed the same.
  idle_timeout = 300

  tags = { Name = var.project }
}

resource "aws_lb_target_group" "web" {
  name     = "${var.project}-web"
  port     = local.node_port
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/"
    matcher             = "200-399"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = data.aws_acm_certificate.app.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# Plain HTTP only redirects. Session cookies are Secure once APP_URL is https, so the app must
# never be used over http.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# Registers the node instances, and keeps doing so as the group scales or replaces them.
resource "aws_autoscaling_attachment" "web" {
  autoscaling_group_name = local.node_asg
  lb_target_group_arn    = aws_lb_target_group.web.arn
}
