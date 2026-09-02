import os, sys, json
os.chdir('/www/server/panel'); sys.path.insert(0, '/www/server/panel'); sys.path.insert(0, '/www/server/panel/class')
import public, panelSite, acme_v2
SITE = 'tmexhub-sh.jiefakj.com'
CONF = '/www/server/panel/vhost/nginx/%s.conf' % SITE
CERT_DIR = '/www/server/panel/vhost/cert/%s' % SITE
site = public.M('sites').where('name=?', (SITE,)).field('id,path').find()
if not os.path.exists(CERT_DIR + '/fullchain.pem'):
    res = acme_v2.acme_v2().apply_cert([SITE], auth_type='http', auth_to=site['path'])
    if isinstance(res, dict) and res.get('status') is False:
        print('APPLY FAIL', res); sys.exit(1)
    print('APPLY OK keys', sorted(res.keys()) if isinstance(res, dict) else type(res))
    if isinstance(res, dict) and res.get('private_key') and res.get('cert'):
        get = public.dict_obj(); get.siteName = SITE; get.type = '1'
        get.key = res['private_key']; get.csr = res['cert'] + (res.get('root') or '')
        print('SETSSL', panelSite.panelSite().SetSSL(get))
else:
    print('CERT exists')
conf = public.readFile(CONF)
if 'listen 127.0.0.1:8443 ssl http2 proxy_protocol;' not in conf and 'listen 443 ssl http2;' in conf:
    conf = conf.replace('    listen 443 ssl http2;\n', '    listen 443 ssl http2;\n    listen 127.0.0.1:8443 ssl http2 proxy_protocol;\n', 1)
    public.writeFile(CONF, conf); print('PATCHED 8443')
if 'HTTP_TO_HTTPS_START' not in conf:
    get = public.dict_obj(); get.siteName = SITE
    print('H2S', panelSite.panelSite().HttpToHttps(get))
print(os.popen('nginx -t 2>&1').read().strip().splitlines()[-1])
public.serviceReload()
print(public.readFile(CERT_DIR + '/info.json') if os.path.exists(CERT_DIR + '/info.json') else 'no info.json')
