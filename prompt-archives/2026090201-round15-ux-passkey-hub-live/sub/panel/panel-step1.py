import os, sys, json
os.chdir('/www/server/panel'); sys.path.insert(0, '/www/server/panel'); sys.path.insert(0, '/www/server/panel/class')
import public, panelSite
existing = public.M('sites').where('name=?', ('tmexhub-sh.jiefakj.com',)).find()
if existing:
    print('EXISTS', existing['id'])
else:
    get = public.dict_obj()
    get.webname = json.dumps({"domain": "tmexhub-sh.jiefakj.com", "domainlist": [], "count": 0})
    get.path = '/www/wwwroot/tmexhub-sh.jiefakj.com'
    get.type_id = '0'; get.type = 'PHP'; get.version = '00'; get.port = '80'
    get.ps = 'tmex hub (Shanghai)'; get.ftp = 'false'; get.sql = 'false'
    print('ADD', panelSite.panelSite().AddSite(get))
print('SITE', public.M('sites').where('name=?', ('tmexhub-sh.jiefakj.com',)).field('id,name,path,status,project_type').find())
