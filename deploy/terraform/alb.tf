locals {
  node_port = 30080
  node_sg   = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  node_asg  = aws_eks_node_group.nodes.resources[0].autoscaling_groups[0].name
}

resource "aws_security_group" "alb" {
  name   = "${var.name}-alb"
  vpc_id = aws_vpc.main.id

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
}

# Let the ALB reach the NodePort on the EKS nodes
resource "aws_security_group_rule" "alb_to_nodes" {
  type                     = "ingress"
  from_port                = local.node_port
  to_port                  = local.node_port
  protocol                 = "tcp"
  security_group_id        = local.node_sg
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_lb" "app" {
  name               = "${var.name}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
  idle_timeout       = 300 # long video range requests
}

resource "aws_lb_target_group" "web" {
  name     = "${var.name}-web"
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

# HTTPS for var.app_domain. Its DNS is in Cloudflare, which Terraform doesn't manage, so the
# validation CNAME (output "acm_validation") is added there by hand while the apply waits.
resource "aws_acm_certificate" "app" {
  domain_name       = var.app_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "app" {
  certificate_arn = aws_acm_certificate.app.arn

  timeouts {
    create = "45m"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.app.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# Plain HTTP only redirects. Session cookies are Secure once APP_URL is https, so the app must
# never be used over http. Waits for the HTTPS listener so the redirect never points at nothing.
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

  depends_on = [aws_lb_listener.https]
}

# Register the EKS node EC2 instances automatically (scales with the group)
resource "aws_autoscaling_attachment" "web" {
  autoscaling_group_name = local.node_asg
  lb_target_group_arn    = aws_lb_target_group.web.arn
}