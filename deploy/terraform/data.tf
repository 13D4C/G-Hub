resource "random_id" "suffix" {
  byte_length = 4
}

variable "media_bucket" {
  type    = string
  default = "g-hub-media-94dc94a4" # the bucket that already exists
}

data "aws_s3_bucket" "media" {
  bucket = var.media_bucket
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = data.aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = data.aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# DynamoDB tables are in dynamodb.tf.

resource "aws_ecr_repository" "app" {
  name                 = var.name
  force_delete         = true
  image_tag_mutability = "MUTABLE"
}