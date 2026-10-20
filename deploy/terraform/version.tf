terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# Configure the AWS Provider. Credentials come from the standard chain: paste the Learner Lab's
# "AWS Details → AWS CLI" block into ~/.aws/credentials (it changes every lab session).
provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "g-hub" }
  }
}
