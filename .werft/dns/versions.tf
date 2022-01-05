terraform {
  backend "gcs" {
    bucket  = "gitpod-core-dev-terraform"
  }
  required_providers {
    google = {
      source = "hashicorp/google"
      version = "3.63.0"
    }
  }
  required_version = ">= 0.13"
}
