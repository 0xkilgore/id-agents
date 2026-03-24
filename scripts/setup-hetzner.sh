#!/bin/bash
# Hetzner Cloud Setup Script for ID Agents
# This script sets up a Hetzner VPS for running the container manager

set -e

echo "🚀 Setting up Hetzner VPS for ID Agents Container Manager"

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo "❌ This script should not be run as root. Run as a regular user with sudo access."
   exit 1
fi

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install required packages
echo "📦 Installing required packages..."
sudo apt install -y curl wget git htop ufw

# Install Node.js 18
echo "📦 Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Docker
echo "🐳 Installing Docker..."
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Enable Docker service
sudo systemctl enable docker
sudo systemctl start docker

# Install Docker Compose (optional, for local testing)
sudo curl -L "https://github.com/docker/compose/releases/download/v2.20.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Create application directory
echo "📁 Creating application directory..."
sudo mkdir -p /opt/id-agents
sudo chown $USER:$USER /opt/id-agents

# Setup firewall
echo "🔥 Configuring firewall..."
sudo ufw allow ssh
sudo ufw allow 3000  # Manager port
sudo ufw allow 8080  # Container manager port
sudo ufw allow 80    # HTTP (optional)
sudo ufw allow 443   # HTTPS (optional)
sudo ufw --force enable

# Create swap space (optional, for better memory management)
echo "💾 Creating swap space..."
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

echo "✅ Hetzner VPS setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Reboot the server: sudo reboot"
echo "2. SSH back in and run: scripts/deploy-container-manager.sh"
echo "3. Configure your .env file with database and API settings"
echo "4. Start the container manager: npm run container-manager"