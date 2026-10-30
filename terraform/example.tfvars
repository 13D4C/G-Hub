# Copy to terraform.tfvars and fill in what you have. Everything is optional:
# with none of it set the site still runs, and only the features that need a
# third party are unavailable.

# project = "g-hub"
# region  = "us-east-1"

# One NAT Gateway per zone matches the architecture diagram. Setting this to
# false shares a single gateway and halves that line of the bill.
# nat_per_az = true

# The lab refuses anything above .large.
# node_instance_type = "t3.large"
# node_desired_size  = 2

# The hostname the ALB serves over HTTPS. Its zone and certificate come from dns/,
# which must be applied first; set the same name there.
# app_domain = "clouddev.natthapong.net"

# Requests per IP per five minutes before WAF blocks it, media excluded.
# waf_rate_limit = 2000

# Stripe test mode only — the app refuses a live key.
# stripe_secret_key     = "sk_test_..."
# stripe_webhook_secret = "whsec_..."

# google_client_id     = "....apps.googleusercontent.com"
# google_client_secret = "..."

# Turn transcoding off entirely to save money while testing.
# worker_replicas = 0
