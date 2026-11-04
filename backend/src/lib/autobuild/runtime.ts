// Trusted generated wrappers; these run only in app/release containers, never
// during detection. They do not rewrite repository files.
export const nodeProxy = `const net = require('node:net');
const addresses = new Set((process.env.DEVFLOW_TRUSTED_PROXIES || '127.0.0.1,::1').split(',').filter(ip => net.isIP(ip)));
try {
  const express = require(require.resolve('express', { paths: [process.cwd()] }));
  const init = express.application.init;
  express.application.init = function () {
    init.call(this);
    this.set('trust proxy', address => addresses.has(address.replace(/^::ffff:/, '')));
  };
} catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
`;
export const djangoSettings = `import importlib, os
from pathlib import Path
from urllib.parse import urlsplit
base = importlib.import_module(os.environ['DEVFLOW_DJANGO_SETTINGS'])
globals().update({name: getattr(base, name) for name in dir(base) if name.isupper()})
public = urlsplit(os.environ.get('DEVFLOW_URL', 'http://localhost'))
DEBUG = os.environ.get('DJANGO_DEBUG', 'false').lower() == 'true'
SECRET_KEY = os.environ['DJANGO_SECRET_KEY']
ALLOWED_HOSTS = [v.strip() for v in os.environ.get('DJANGO_ALLOWED_HOSTS', os.environ.get('ALLOWED_HOSTS', (public.hostname or 'localhost') + ',localhost,127.0.0.1,.localhost')).split(',') if v.strip()]
CSRF_TRUSTED_ORIGINS = [v.strip() for v in os.environ.get('DJANGO_CSRF_TRUSTED_ORIGINS', public.scheme + '://' + public.netloc).split(',') if v.strip()]
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
if getattr(base, 'STATIC_ROOT', None) or os.environ.get('DJANGO_STATIC_ROOT'):
    STATIC_ROOT = Path('/app/.devflow-static')
`;
export const pythonWsgi = `import importlib, ipaddress, os
target = os.environ['DEVFLOW_PYTHON_TARGET']
module, attribute = target.split(':', 1)
app = getattr(importlib.import_module(module), attribute)
if os.environ['DEVFLOW_PYTHON_FRAMEWORK'] == 'django':
    from django.conf import settings
    if getattr(settings, 'STATIC_ROOT', None):
        from whitenoise import WhiteNoise
        app = WhiteNoise(app, root=str(settings.STATIC_ROOT), prefix=settings.STATIC_URL)
elif os.environ['DEVFLOW_PYTHON_FRAMEWORK'] == 'flask':
    from werkzeug.middleware.proxy_fix import ProxyFix
    proxied = ProxyFix(app, x_for=1, x_proto=1)
trusted = set(os.environ.get('DEVFLOW_TRUSTED_PROXIES', '127.0.0.1,::1').split(','))
def application(environ, start_response):
    address = environ.get('REMOTE_ADDR', '').removeprefix('::ffff:')
    if address not in trusted:
        for key in list(environ):
            if key.startswith('HTTP_X_FORWARDED_') or key == 'HTTP_FORWARDED':
                environ.pop(key, None)
    if os.environ['DEVFLOW_PYTHON_FRAMEWORK'] == 'flask' and address in trusted:
        return proxied(environ, start_response)
    return app(environ, start_response)
`;
export const pythonLaunch = `import os, sys
framework = os.environ['DEVFLOW_PYTHON_FRAMEWORK']
trusted = os.environ.get('DEVFLOW_TRUSTED_PROXIES', '127.0.0.1,::1')
if framework == 'fastapi':
    import uvicorn
    uvicorn.run(os.environ['DEVFLOW_PYTHON_TARGET'], host='0.0.0.0', port=int(os.environ['PORT']), proxy_headers=True, forwarded_allow_ips=trusted, workers=1)
else:
    if framework == 'django':
        import django
        django.setup()
        from django.conf import settings
        if getattr(settings, 'STATIC_ROOT', None):
            from django.core.management import call_command
            call_command('collectstatic', interactive=False, verbosity=0)
        import devflow_wsgi
    sys.argv = ['gunicorn', 'devflow_wsgi:application', '--bind', '0.0.0.0:' + os.environ['PORT'], '--workers', '1', '--threads', '2', '--worker-tmp-dir', '/tmp', '--forwarded-allow-ips', trusted]
    from gunicorn.app.wsgiapp import run
    run()
`;
