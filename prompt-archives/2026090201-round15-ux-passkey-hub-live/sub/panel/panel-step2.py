import os, sys, json, re
os.chdir('/www/server/panel'); sys.path.insert(0, '/www/server/panel'); sys.path.insert(0, '/www/server/panel/class')
import public, panelSite
SITE = 'tmexhub-sh.jiefakj.com'
CONF = '/www/server/panel/vhost/nginx/%s.conf' % SITE
ps = panelSite.panelSite()
proxy_conf_dir = '/www/server/panel/vhost/nginx/proxy/%s' % SITE
if not os.path.isdir(proxy_conf_dir) or not os.listdir(proxy_conf_dir):
    get = public.dict_obj()
    get.sitename = SITE; get.proxyname = 'tmex'; get.proxydir = '/'
    get.proxysite = 'http://10.108.57.1:9883'; get.todomain = '$host'
    get.type = '1'; get.cache = '0'; get.advanced = '0'; get.subfilter = '[]'; get.cachetime = '1'
    print('PROXY', ps.CreateProxy(get))
else:
    print('PROXY exists', os.listdir(proxy_conf_dir))
conf = public.readFile(CONF)
if 'listen 127.0.0.1:8081 proxy_protocol;' not in conf:
    conf = conf.replace('    listen 80;\n', '    listen 80;\n    listen 127.0.0.1:8081 proxy_protocol;\n', 1)
    public.writeFile(CONF, conf)
    print('PATCHED 8081')
orders = json.load(open('/www/server/panel/config/letsencrypt.json')).get('orders', {})
for k, v in list(orders.items())[:8]:
    print('ORDER', v.get('domains'), v.get('auth_type'), v.get('auth_to'), v.get('save_path'), v.get('deploy_ids') if isinstance(v, dict) else None)
print(os.popen('nginx -t 2>&1').read().strip())
public.serviceReload()
