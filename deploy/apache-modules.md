# Required Apache Modules for AlfyAI Reverse Proxy

This document lists the Apache modules required for the VirtualHost configuration in `apache-site.conf` and provides commands to enable them.

## Required Modules

1. **mod_proxy** - Core proxy functionality
2. **mod_proxy_http** - HTTP proxy support
3. **mod_ssl** - SSL/TLS support for HTTPS
4. **mod_headers** - HTTP header manipulation
5. **mod_setenvif** - Setting environment variables based on request characteristics

## Enabling the Modules

On Debian/Ubuntu systems, use the following commands to enable the required modules:

```bash
sudo a2enmod proxy
sudo a2enmod proxy_http
sudo a2enmod ssl
sudo a2enmod headers
sudo a2enmod setenvif
```

After enabling the modules, restart Apache to apply the changes:

```bash
sudo systemctl restart apache2
# or
sudo service apache2 restart
```

## Verification

To verify that the modules are enabled, you can check the enabled mods directory:

```bash
ls /etc/apache2/mods-enabled/ | grep -E "proxy|ssl|headers|setenvif"
```

You should see the corresponding `.load` and `.conf` files for each module.

## Notes

- These modules are standard in most Apache installations
- The `mod_proxy` and `mod_proxy_http` modules are essential for reverse proxy functionality
- `mod_ssl` is required for HTTPS support
- `mod_headers` and `mod_setenvif` are used for the streaming response anti-buffering directives
