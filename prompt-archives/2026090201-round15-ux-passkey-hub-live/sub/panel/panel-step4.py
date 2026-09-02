import os, sys, re
os.chdir('/www/server/panel'); sys.path.insert(0, '/www/server/panel'); sys.path.insert(0, '/www/server/panel/class')
import public
SITE = 'tmexhub-sh.jiefakj.com'
CONF = '/www/server/panel/vhost/nginx/%s.conf' % SITE
conf = public.readFile(CONF)
if 'listen 127.0.0.1:8443 ssl http2 proxy_protocol;' not in conf:
    conf = re.sub(r'([ \t]*)listen 443 ssl http2;\n', lambda m: m.group(0) + m.group(1) + 'listen 127.0.0.1:8443 ssl http2 proxy_protocol;\n', conf, count=1)
    public.writeFile(CONF, conf); print('PATCHED 8443')
if 'listen 127.0.0.1:8081 proxy_protocol;' not in conf:
    conf = re.sub(r'([ \t]*)listen 80;\n', lambda m: m.group(0) + m.group(1) + 'listen 127.0.0.1:8081 proxy_protocol;\n', conf, count=1)
    public.writeFile(CONF, conf); print('PATCHED 8081')
print(os.popen('nginx -t 2>&1').read().strip().splitlines()[-1]); public.serviceReload()
print(conf[:900])
