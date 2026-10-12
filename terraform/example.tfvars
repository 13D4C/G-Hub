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

# Google sign-in needs HTTPS, which needs a domain and a certificate on the load
# balancer. Without them the site runs on the load balancer's own HTTP hostname
# and email/password sign-in still works.
# app_url = "https://g-hub.example.com"

# Stripe test mode only — the app refuses a live key.
# stripe_secret_key     = "sk_test_..."
# stripe_webhook_secret = "whsec_..."

# google_client_id     = "....apps.googleusercontent.com"
# google_client_secret = "..."

# Turn transcoding off entirely to save money while testing.
# worker_replicas = 0
