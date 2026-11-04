SECRET_KEY = 'devflow-test-fixture-only'
DEBUG = False
ALLOWED_HOSTS = ['*']
ROOT_URLCONF = 'config.urls'
INSTALLED_APPS = []
MIDDLEWARE = []

from pathlib import Path
BASE_DIR = Path(__file__).resolve().parent.parent
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': BASE_DIR / 'db.sqlite3'}}
STATIC_ROOT = BASE_DIR / 'static-collected'
STATIC_URL = '/static/'
INSTALLED_APPS = ['django.contrib.staticfiles', 'core']
