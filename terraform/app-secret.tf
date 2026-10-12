resource "random_password" "session_secret" {
  length  = 64
  special = false
}
