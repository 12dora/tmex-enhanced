import os, sys, glob
os.chdir('/www/server/panel'); sys.path.insert(0, '/www/server/panel'); sys.path.insert(0, '/www/server/panel/class')
import public
SITE = 'tmexhub-sh.jiefakj.com'
CONF = '/www/server/panel/vhost/nginx/%s.conf' % SITE
conf = public.readFile(CONF)
if 'if ($server_port !~ 443){' in conf:
    conf = conf.replace('if ($server_port !~ 443){', 'if ($scheme = http){', 1); public.writeFile(CONF, conf); print('PATCHED scheme')
for f in glob.glob('/www/server/panel/vhost/nginx/proxy/%s/*.conf' % SITE):
    p = public.readFile(f)
    if '$proxy_protocol_addr' not in p:
        p = p.replace('proxy_set_header X-Real-IP $remote_addr;', 'proxy_set_header X-Real-IP $proxy_protocol_addr;')
        p = p.replace('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', 'proxy_set_header X-Forwarded-For $proxy_protocol_addr;')
        p = p.replace('proxy_set_header REMOTE-HOST $remote_addr;', 'proxy_set_header REMOTE-HOST $proxy_protocol_addr;\n    proxy_set_header X-Forwarded-Proto https;\n    proxy_set_header X-Forwarded-Host $host;\n    proxy_read_timeout 3600s;\n    proxy_send_timeout 3600s;\n    proxy_buffering off;')
        public.writeFile(f, p); print('PATCHED proxy', f)
print(os.popen('nginx -t 2>&1').read().strip().splitlines()[-1]); public.serviceReload()
