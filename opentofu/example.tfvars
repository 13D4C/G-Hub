project = "g-hub-tofu"
region  = "us-east-1"

nat_per_az = true

node_instance_type = "t3.large"
node_desired_size  = 2

web_replicas    = 2
worker_replicas = 1

app_url = ""

stripe_secret_key     = ""
stripe_webhook_secret = ""

google_client_id     = ""
google_client_secret = ""
