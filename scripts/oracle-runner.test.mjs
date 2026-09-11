import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runner = fileURLToPath(new URL('../deploy/oracle-update.py', import.meta.url));
const prelude = `import importlib.util, pathlib, contextlib, tempfile
spec=importlib.util.spec_from_file_location('oracle_runner', ${JSON.stringify(runner)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
`;
function python(script) {
  const result = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-B', '-c', prelude + script],
    { encoding: 'utf8', windowsHide: true }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

test('candidate Compose validation resolves service env_file from production without copying secrets', () =>
  python(`
with tempfile.TemporaryDirectory() as temp:
    base=pathlib.Path(temp).resolve(); app=base/'app'; app.mkdir(); candidate=base/'candidate'; candidate.mkdir()
    original='NR_ACCESS_TOKEN=private-value\\n'
    (app/'.env.self-host').write_text(original)
    (candidate/'compose.tailscale.yaml').write_text('services:\\n  app:\\n    env_file: .env.self-host\\n')
    calls=[]
    class Fake(m.Runner):
        def docker(self,*args,**kwargs):
            calls.append((args,kwargs))
            compose_file=pathlib.Path(args[args.index('-f')+1])
            project=pathlib.Path(args[args.index('--project-directory')+1]) if '--project-directory' in args else compose_file.parent
            assert (project/'.env.self-host').read_text()==original
            assert args[args.index('--env-file')+1]==str(app/'.env.self-host')
            assert compose_file==candidate/'compose.tailscale.yaml'
            assert args[-2:]==('config','--quiet')
            assert original not in ' '.join(args)
            return ''
    r=object.__new__(Fake); r.app=app; r.env=app/'.env.self-host'
    r.compose('config','--quiet',cwd=candidate)
    assert len(calls)==1
    assert (app/'.env.self-host').read_text()==original
    assert sorted(p.name for p in candidate.iterdir())==['compose.tailscale.yaml']
`));

test('runner validates exact identities and explicit fresh/prebuilt/check-only options', () =>
  python(`
m.Path=pathlib.PurePosixPath
base=['--commit','a'*40,'--build-id','b'*64,'--dist-hash','c'*64,'--release-dir','/opt/uimori/releases/test']
a=m.arguments(base+['--fresh','--image','ghcr.io/team/app@sha256:'+'d'*64,'--check-only'])
assert a.fresh and a.check_only and a.image.startswith('ghcr.io/')
for extra in [['--commit','bad'],['--release-dir','/opt/uimori/releases/../app'],['--image','--bad']]:
    try: m.arguments(base+extra)
    except SystemExit as e: assert e.code==2
    else: raise AssertionError('unsafe argument accepted')
`));

test('environment update preserves unrelated lines and full rollback restores original bytes', () =>
  python(`
text='# operator comment\\nNR_ACCESS_TOKEN="secret keep"\\nNR_PUBLIC_ORIGIN=https://example.test\\nUIMORI_IMAGE_TAG=old\\nUIMORI_DATA_VOLUME=old-volume\\n'
changed=m.update_environment(text,'sha256:'+'a'*64,'new-volume')
assert m.protected_environment(text)==m.protected_environment(changed)
assert 'NR_ACCESS_TOKEN="secret keep"' in changed
assert 'UIMORI_IMAGE_TAG=' not in changed
assert m.environment_values(text)['NR_ACCESS_TOKEN']=='secret keep'
`));

test('rollback stops candidate before restoring backup and uses immutable previous image override', () =>
  python(`
events=[]
class Fake(m.Runner):
    @contextlib.contextmanager
    def stage(self,name): yield
    def data(self,action,*args,**kwargs): events.append(action)
    def compose(self,*args): events.append(args[0])
    def run(self,*args,**kwargs): events.append(args[0])
    def write_env(self,text): assert text=='original'; events.append('env')
    def docker(self,*args): events.append('start')
    def routing(self): return {}
    def wait_healthy(self,image,volume): assert image=='sha256:old' and volume=='old'; events.append('healthy')
with tempfile.TemporaryDirectory() as temp:
    r=object.__new__(Fake); r.stopped=True; r.candidate_started=True; r.backed_up=True; r.checked_out=True
    r.summary={}; r.volume_name='new'; r.old_volume='old'; r.image='sha256:new'; r.old_image='sha256:old'; r.previous='previous'; r.old_env='original'; r.private=pathlib.Path(temp); r.app=r.private; r.env=r.private/'env'
    r.env.write_text('original'); r.old_routing={}
    r.rollback()
    assert events==['inspect','stop','inspect','restore','git','env','start','healthy'],events
    assert r.summary['rollback']=='PASS'
    assert 'sha256:old' in (r.private/'rollback.json').read_text()
`));

test('rollback refuses to stop or restore candidate when new user work is active', () =>
  python(`
class Fake(m.Runner):
    @contextlib.contextmanager
    def stage(self,name): yield
    def data(self,*args,**kwargs): raise RuntimeError('Active work')
    def compose(self,*args): raise AssertionError('must not stop active application')
r=object.__new__(Fake); r.stopped=True; r.candidate_started=True; r.summary={}; r.volume_name='new'; r.image='image'
try: r.rollback()
except RuntimeError as e: assert str(e)=='Active work'
else: raise AssertionError('active work was accepted')
`));

test('check-only builds once and probes fresh plus coherent copy without switching app or volume', () =>
  python(`
from types import SimpleNamespace
events=[]
config={'services':{'app':{'image':'configured-old','environment':{'NR_PUBLIC_ORIGIN':'https://example.test'},'build':{'args':{'UIMORI_CODEX_VERSION':'1.0'}}}},'volumes':{'data':{'name':'old'}}}
class Fake(m.Runner):
    def run(self,*args,cwd=None,**kwargs):
        events.append(args[:2])
        if args[:2]==('git','status'): return ''
        if args[:2]==('git','rev-parse'): return 'a'*40 if cwd or args[-1]=='origin/main' else 'b'*40
        if args[:2]==('git','ls-remote'): return 'a'*40+' refs/heads/main'
        return ''
    def inspect(self): return {'HostConfig':{'PortBindings':{'4310/tcp':[{'HostIp':'127.0.0.1','HostPort':'4310'}]}},'State':{'Health':{'Status':'healthy'}},'Image':'sha256:old','Mounts':[{'Destination':'/data','Type':'volume','Name':'old'}],'Config':{'Env':['NR_PUBLIC_ORIGIN=https://example.test']}}
    def routing(self): return {}
    def compose(self,*args,**kwargs):
        events.append(('compose',args[0])); assert args[0]=='config'
        return m.json.dumps(config)
    def data(self,action,*args,**kwargs): events.append(('data',action)); return {}
    def new_volume(self,*args,**kwargs): return 'isolated'
    def probe(self,*args): events.append(('probe',bool(args))); return {'status':'PASS','database':{'columns':{}}}
    def docker(self,*args,**kwargs):
        events.append(('docker',args[0]))
        return m.json.dumps([{'Id':'sha256:old' if args[-1]=='configured-old' else 'sha256:new'}]) if args[:2]==('image','inspect') else ''
with tempfile.TemporaryDirectory() as temp:
    base=pathlib.Path(temp).resolve(); app=base/'app'; app.mkdir(); release=base/'release'; release.mkdir()
    (app/'.env.self-host').write_text('NR_PUBLIC_ORIGIN=https://example.test\\n')
    args=SimpleNamespace(app_dir=str(app),release_dir=str(release),commit='a'*40,build_id='c'*64,dist_hash='d'*64,fresh=False,check_only=True,image=None,expected_origin='https://example.test')
    r=Fake(args); r.execute()
    assert r.summary['status']=='PASS'
    assert events.count(('docker','build'))==1
    assert events.count(('probe',False))==1 and events.count(('probe',True))==1
    assert ('data','snapshot') in events
    assert ('git','checkout') not in events
    assert not r.stopped and not r.checked_out and not r.candidate_started
`));

test('same-version database missing a candidate column fails semantic compatibility; extra columns remain allowed', () =>
  python(`
shape={'type':'TEXT','notnull':0,'pk':0}
expected={'helper_tasks':{'id':shape,'started_at':shape}}
actual={'helper_tasks':{'id':shape}}
try: m.validate_columns(expected,actual)
except RuntimeError as e: assert 'helper_tasks.started_at' in str(e) and '--fresh' in str(e)
else: raise AssertionError('missing current column accepted')
actual['helper_tasks'].update(started_at=shape,retired_column=shape)
assert m.validate_columns(expected,actual)['status']=='PASS'
`));
