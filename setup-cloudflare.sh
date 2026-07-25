#!/bin/bash

# Cloudflare Setup Script
# هذا السكربت بيعمل setup كامل لـ Cloudflare API

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}   Cloudflare Setup Script${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

check_dependencies() {
    print_info "Checking dependencies..."
    
    if ! command -v curl &> /dev/null; then
        print_error "curl is required. Please install it first."
        exit 1
    fi
    
    if ! command -v jq &> /dev/null; then
        print_warning "jq is not installed. Installing..."
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            sudo apt-get update && sudo apt-get install -y jq
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            brew install jq
        fi
    fi
    
    print_success "Dependencies check passed"
}

verify_token() {
    local token=$1
    
    print_info "Verifying API token..."
    
    response=$(curl -s -H "Authorization: Bearer $token" \
        "https://api.cloudflare.com/client/v4/user/tokens/verify")
    
    success=$(echo "$response" | jq -r '.success')
    
    if [ "$success" = "true" ]; then
        print_success "API token is valid"
        return 0
    else
        print_error "Invalid API token"
        echo "$response" | jq -r '.errors[]?.message' 2>/dev/null || echo "Unknown error"
        return 1
    fi
}

get_account_info() {
    local token=$1
    
    print_info "Fetching account information..."
    
    response=$(curl -s -H "Authorization: Bearer $token" \
        "https://api.cloudflare.com/client/v4/accounts")
    
    success=$(echo "$response" | jq -r '.success')
    
    if [ "$success" = "true" ]; then
        account_count=$(echo "$response" | jq '.result | length')
        
        if [ "$account_count" -eq 0 ]; then
            print_error "No accounts found"
            return 1
        elif [ "$account_count" -eq 1 ]; then
            ACCOUNT_ID=$(echo "$response" | jq -r '.result[0].id')
            ACCOUNT_NAME=$(echo "$response" | jq -r '.result[0].name')
            print_success "Account found: $ACCOUNT_NAME ($ACCOUNT_ID)"
        else
            echo -e "${YELLOW}Multiple accounts found:${NC}"
            echo "$response" | jq -r '.result | to_entries[] | "\(.key + 1). \(.value.name) (\(.value.id))"'
            echo ""
            read -p "Select account number (1-$account_count): " account_num
            
            if [[ "$account_num" =~ ^[0-9]+$ ]] && [ "$account_num" -ge 1 ] && [ "$account_num" -le "$account_count" ]; then
                ACCOUNT_ID=$(echo "$response" | jq -r ".result[$((account_num-1))].id")
                ACCOUNT_NAME=$(echo "$response" | jq -r ".result[$((account_num-1))].name")
                print_success "Account selected: $ACCOUNT_NAME ($ACCOUNT_ID)"
            else
                print_error "Invalid selection"
                return 1
            fi
        fi
    else
        print_error "Failed to fetch accounts"
        return 1
    fi
}

get_zone_info() {
    local token=$1
    
    print_info "Fetching zones..."
    
    response=$(curl -s -H "Authorization: Bearer $token" \
        "https://api.cloudflare.com/client/v4/zones")
    
    success=$(echo "$response" | jq -r '.success')
    
    if [ "$success" = "true" ]; then
        zone_count=$(echo "$response" | jq '.result | length')
        
        if [ "$zone_count" -eq 0 ]; then
            print_warning "No zones found. You can add them later."
            return 0
        fi
        
        echo -e "${YELLOW}Available zones:${NC}"
        echo "$response" | jq -r '.result | to_entries[] | "\(.key + 1). \(.value.name) (\(.value.id))"'
        echo ""
        read -p "Select zone number (1-$zone_count) or press Enter to skip: " zone_num
        
        if [[ -z "$zone_num" ]]; then
            print_info "Skipping zone selection"
            return 0
        fi
        
        if [[ "$zone_num" =~ ^[0-9]+$ ]] && [ "$zone_num" -ge 1 ] && [ "$zone_num" -le "$zone_count" ]; then
            ZONE_ID=$(echo "$response" | jq -r ".result[$((zone_num-1))].id")
            ZONE_NAME=$(echo "$response" | jq -r ".result[$((zone_num-1))].name")
            print_success "Zone selected: $ZONE_NAME ($ZONE_ID)"
        else
            print_error "Invalid selection"
            return 1
        fi
    else
        print_error "Failed to fetch zones"
        return 1
    fi
}

create_env_file() {
    local token=$1
    
    print_info "Creating .env file..."
    
    cat > .env << EOF
# Cloudflare API Token
CLOUDFLARE_API_TOKEN=${token}

# Account ID
CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID:-}

# Zone ID
CLOUDFLARE_ZONE_ID=${ZONE_ID:-}

# Optional: Email (for legacy API)
# CLOUDFLARE_EMAIL=your-email@example.com

# Optional: API Key (for legacy API)
# CLOUDFLARE_API_KEY=your-api-key
EOF
    
    chmod 600 .env
    print_success ".env file created with secure permissions"
}

setup_zero_trust() {
    local token=$1
    
    print_info "Checking Zero Trust status..."
    
    response=$(curl -s -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/zero_trust/accounts")
    
    success=$(echo "$response" | jq -r '.success')
    
    if [ "$success" = "true" ]; then
        print_success "Zero Trust is already configured"
        
        # Get organization info
        org_name=$(echo "$response" | jq -r '.result[0].name // "N/A"')
        print_info "Organization: $org_name"
    else
        print_warning "Zero Trust not configured yet"
        print_info "You can configure it later from: https://dash.cloudflare.com/?to=/:account/zero-trust"
    fi
}

setup_tunnel() {
    local token=$1
    
    print_info "Checking existing tunnels..."
    
    response=$(curl -s -H "Authorization: Bearer $token" \
        "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel")
    
    success=$(echo "$response" | jq -r '.success')
    
    if [ "$success" = "true" ]; then
        tunnel_count=$(echo "$response" | jq '.result | length')
        
        if [ "$tunnel_count" -gt 0 ]; then
            print_info "Found $tunnel_count existing tunnel(s):"
            echo "$response" | jq -r '.result[] | "  - \(.name) (\(.id))"'
        else
            print_info "No existing tunnels found"
        fi
    else
        print_warning "Could not fetch tunnels"
    fi
}

show_permissions() {
    local token=$1
    
    print_info "Checking token permissions..."
    
    response=$(curl -s -H "Authorization: Bearer $token" \
        "https://api.cloudflare.com/client/v4/user/tokens/verify")
    
    permissions=$(echo "$response" | jq -r '.result.permissions | keys[]' 2>/dev/null || echo "Unable to fetch")
    
    echo -e "${YELLOW}Token permissions:${NC}"
    echo "$permissions" | while read -r perm; do
        echo "  - $perm"
    done
}

main() {
    print_header
    
    # Check dependencies
    check_dependencies
    echo ""
    
    # Get API token
    echo -e "${YELLOW}Please enter your Cloudflare API token:${NC}"
    read -p "Token: " API_TOKEN
    
    if [ -z "$API_TOKEN" ]; then
        print_error "Token cannot be empty"
        exit 1
    fi
    
    # Verify token
    if ! verify_token "$API_TOKEN"; then
        exit 1
    fi
    echo ""
    
    # Show permissions
    show_permissions "$API_TOKEN"
    echo ""
    
    # Get account info
    if ! get_account_info "$API_TOKEN"; then
        exit 1
    fi
    echo ""
    
    # Get zone info
    get_zone_info "$API_TOKEN"
    echo ""
    
    # Create .env file
    create_env_file "$API_TOKEN"
    echo ""
    
    # Setup Zero Trust
    setup_zero_trust "$API_TOKEN"
    echo ""
    
    # Check tunnels
    setup_tunnel "$API_TOKEN"
    echo ""
    
    # Summary
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}   Setup Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "${BLUE}Account:${NC} ${ACCOUNT_NAME:-N/A} (${ACCOUNT_ID:-N/A})"
    echo -e "${BLUE}Zone:${NC} ${ZONE_NAME:-N/A} (${ZONE_ID:-N/A})"
    echo -e "${BLUE}Env file:${NC} .env"
    echo ""
    echo -e "${YELLOW}Next steps:${NC}"
    echo "1. Run the MCP server: npx -y @thelord/mcp-cloudflare"
    echo "2. Or configure tunnels from: https://dash.cloudflare.com/?to=/:account/tunnels"
    echo "3. Set up access policies from: https://dash.cloudflare.com/?to=/:account/zero-trust"
    echo ""
}

# Run main function
main "$@"
