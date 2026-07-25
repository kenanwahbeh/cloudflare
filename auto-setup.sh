#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

CF_API="https://api.cloudflare.com/client/v4"

# Load existing .env if exists
if [ -f .env ]; then
    source .env
fi

api_call() {
    local method=$1
    local endpoint=$2
    local data=$3
    
    if [ -n "$data" ]; then
        curl -s -X "$method" \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            -H "Content-Type: application/json" \
            "$CF_API$endpoint" \
            -d "$data"
    else
        curl -s -X "$method" \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            "$CF_API$endpoint"
    fi
}

ask_approval() {
    local msg=$1
    echo -e "${YELLOW}$msg${NC}"
    read -p "Approve? (y/n): " choice
    [[ "$choice" =~ ^[Yy]$ ]]
}

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Cloudflare Auto Setup Script       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

# Step 1: Get API Token
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo -e "${CYAN}Step 1: API Token${NC}"
    echo "Get token from: https://dash.cloudflare.com/profile/api-tokens"
    read -p "Paste API Token: " CLOUDFLARE_API_TOKEN
    
    if ! ask_approval "Save token to .env?"; then
        echo "Exiting..."
        exit 1
    fi
    
    echo "CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN" > .env
    chmod 600 .env
    echo -e "${GREEN}Token saved${NC}"
else
    echo -e "${GREEN}✓ API Token loaded from .env${NC}"
fi

# Step 2: Verify Token
echo ""
echo -e "${CYAN}Step 2: Verifying Token${NC}"
response=$(api_call GET "/user/tokens/verify")
if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Token is valid${NC}"
    echo "$response" | jq -r '.result.permissions | keys[]' 2>/dev/null | while read p; do echo "  - $p"; done
else
    echo -e "${RED}✗ Invalid token${NC}"
    exit 1
fi

# Step 3: Get Account
echo ""
echo -e "${CYAN}Step 3: Fetching Accounts${NC}"
response=$(api_call GET "/accounts")
accounts=$(echo "$response" | jq -r '.result[] | "\(.id)|\(.name)"')

account_count=$(echo "$accounts" | wc -l)
if [ "$account_count" -eq 0 ]; then
    echo -e "${RED}No accounts found${NC}"
    exit 1
elif [ "$account_count" -eq 1 ]; then
    CLOUDFLARE_ACCOUNT_ID=$(echo "$accounts" | cut -d'|' -f1)
    ACCOUNT_NAME=$(echo "$accounts" | cut -d'|' -f2)
    echo -e "${GREEN}✓ Account: $ACCOUNT_NAME${NC}"
else
    echo "Multiple accounts:"
    echo "$accounts" | nl
    read -p "Select account (1-$account_count): " num
    CLOUDFLARE_ACCOUNT_ID=$(echo "$accounts" | sed -n "${num}p" | cut -d'|' -f1)
    ACCOUNT_NAME=$(echo "$accounts" | sed -n "${num}p" | cut -d'|' -f2)
    echo -e "${GREEN}✓ Selected: $ACCOUNT_NAME${NC}"
fi

# Step 4: Get Zones
echo ""
echo -e "${CYAN}Step 4: Fetching Zones${NC}"
response=$(api_call GET "/zones")
zones=$(echo "$response" | jq -r '.result[] | "\(.id)|\(.name)"')

zone_count=$(echo "$zones" | wc -l)
if [ "$zone_count" -gt 0 ]; then
    echo "Available zones:"
    echo "$zones" | nl
    read -p "Select zone (1-$zone_count) or Enter to skip: " num
    
    if [ -n "$num" ] && [ "$num" -ge 1 ] && [ "$num" -le "$zone_count" ]; then
        CLOUDFLARE_ZONE_ID=$(echo "$zones" | sed -n "${num}p" | cut -d'|' -f1)
        ZONE_NAME=$(echo "$zones" | sed -n "${num}p" | cut -d'|' -f2)
        echo -e "${GREEN}✓ Zone: $ZONE_NAME${NC}"
    fi
fi

# Update .env
cat > .env << EOF
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID=${CLOUDFLARE_ZONE_ID:-}
EOF
chmod 600 .env

# Step 5: Setup Tunnel
echo ""
echo -e "${CYAN}Step 5: Cloudflare Tunnel${NC}"

if ask_approval "Create a new tunnel?"; then
    read -p "Tunnel name: " TUNNEL_NAME
    
    if [ -z "$TUNNEL_NAME" ]; then
        TUNNEL_NAME="my-tunnel"
    fi
    
    response=$(api_call POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel" \
        "{\"name\":\"$TUNNEL_NAME\",\"tunnel_secret\":\"$(openssl rand -base64 32)\"}")
    
    if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
        TUNNEL_ID=$(echo "$response" | jq -r '.result.id')
        TUNNEL_TOKEN=$(echo "$response" | jq -r '.result.token')
        echo -e "${GREEN}✓ Tunnel created: $TUNNEL_NAME ($TUNNEL_ID)${NC}"
        
        # Save tunnel info
        cat >> .env << EOF
TUNNEL_ID=$TUNNEL_ID
TUNNEL_TOKEN=$TUNNEL_TOKEN
EOF
        
        # Ask for public hostname
        if ask_approval "Add a public hostname?"; then
            read -p "Hostname (e.g., app.example.com): " HOSTNAME
            read -p "Service URL (e.g., http://localhost:3000): " SERVICE
            
            response=$(api_call PUT "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
                "{\"config\":{\"ingress\":[{\"hostname\":\"$HOSTNAME\",\"service\":\"$SERVICE\"},{\"service\":\"http_status:404\"}]}}")
            
            if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
                echo -e "${GREEN}✓ Tunnel configured with hostname: $HOSTNAME${NC}"
                
                # Create DNS record
                response=$(api_call POST "/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
                    "{\"type\":\"CNAME\",\"name\":\"$HOSTNAME\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}")
                
                if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
                    echo -e "${GREEN}✓ DNS record created${NC}"
                fi
            fi
        fi
    else
        echo -e "${RED}✗ Failed to create tunnel${NC}"
        echo "$response" | jq -r '.errors[]?.message'
    fi
else
    # Check existing tunnels
    response=$(api_call GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel")
    if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
        tunnel_count=$(echo "$response" | jq '.result | length')
        if [ "$tunnel_count" -gt 0 ]; then
            echo "Existing tunnels:"
            echo "$response" | jq -r '.result[] | "  - \(.name) (\(.id))"'
        else
            echo "No existing tunnels"
        fi
    fi
fi

# Step 6: Setup Access Policy
echo ""
echo -e "${CYAN}Step 6: Zero Trust Access${NC}"

if ask_approval "Create Access policy for email-based auth?"; then
    read -p "Email or domain to allow (e.g., user@example.com or @example.com): " EMAIL_PATTERN
    
    if [[ "$EMAIL_PATTERN" == @* ]]; then
        # Domain pattern
        POLICY_TYPE="email_domain"
        POLICY_VALUE="$EMAIL_PATTERN"
    else
        # Specific email
        POLICY_TYPE="email"
        POLICY_VALUE="$EMAIL_PATTERN"
    fi
    
    response=$(api_call POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/policies" \
        "{\"name\":\"Allow $EMAIL_PATTERN\",\"decision\":\"allow\",\"include\":[{\"$POLICY_TYPE\":{\"$POLICY_TYPE\":\"$POLICY_VALUE\"}}]}")
    
    if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
        POLICY_ID=$(echo "$response" | jq -r '.result.id')
        echo -e "${GREEN}✓ Access policy created: $POLICY_ID${NC}"
        
        # Create Access application
        if [ -n "$HOSTNAME" ]; then
            if ask_approval "Create Access application for $HOSTNAME?"; then
                response=$(api_call POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/applications" \
                    "{\"type\":\"self_hosted\",\"name\":\"$HOSTNAME\",\"domain\":\"$HOSTNAME\",\"policies\":[{\"id\":\"$POLICY_ID\",\"precedence\":1}]}")
                
                if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
                    echo -e "${GREEN}✓ Access application created${NC}"
                fi
            fi
        fi
    else
        echo -e "${RED}✗ Failed to create policy${NC}"
        echo "$response" | jq -r '.errors[]?.message'
    fi
fi

# Step 7: Install cloudflared (optional)
echo ""
echo -e "${CYAN}Step 7: Install cloudflared${NC}"

if ask_approval "Install cloudflared locally?"; then
    if command -v cloudflared &> /dev/null; then
        echo -e "${GREEN}✓ cloudflared already installed${NC}"
    else
        echo "Installing cloudflared..."
        
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
            echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
            sudo apt update && sudo apt install -y cloudflared
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            brew install cloudflared
        fi
        
        echo -e "${GREEN}✓ cloudflared installed${NC}"
    fi
fi

# Summary
echo ""
echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Setup Complete!             ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Account:${NC} ${ACCOUNT_NAME:-N/A}"
echo -e "${GREEN}Account ID:${NC} ${CLOUDFLARE_ACCOUNT_ID:-N/A}"
echo -e "${GREEN}Zone:${NC} ${ZONE_NAME:-N/A}"
echo -e "${GREEN}Zone ID:${NC} ${CLOUDFLARE_ZONE_ID:-N/A}"
[ -n "$TUNNEL_ID" ] && echo -e "${GREEN}Tunnel:${NC} ${TUNNEL_NAME:-N/A} (${TUNNEL_ID:-N/A})"
[ -n "$HOSTNAME" ] && echo -e "${GREEN}Hostname:${NC} ${HOSTNAME}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Run tunnel: cloudflared tunnel run $TUNNEL_NAME"
echo "2. Or use MCP: npx -y @thelord/mcp-cloudflare"
echo "3. Dashboard: https://dash.cloudflare.com/?to=/:account/zero-trust"
