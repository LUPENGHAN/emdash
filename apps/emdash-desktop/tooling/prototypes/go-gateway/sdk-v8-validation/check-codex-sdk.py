import os,tempfile,pathlib,json,subprocess,urllib.request
boot=json.loads(pathlib.Path('/tmp/emdash-sdk-validation/v8-boot.json').read_text());base=boot['url']
def route(provider):
 r=urllib.request.urlopen(urllib.request.Request(base+'/probe/routes/one/'+provider,method='PUT',headers={'Authorization':'Bearer probe-management'}));assert r.status==204;r.close()
with tempfile.TemporaryDirectory(prefix='emdash-v8-codex-') as work:
 home=pathlib.Path(work)/'codex';home.mkdir()
 (home/'config.toml').write_text('model="test"\nmodel_provider="emdash-v8-probe"\n[model_providers.emdash-v8-probe]\nname="Emdash v8 probe"\nbase_url='+json.dumps(base+'/v1')+'\nwire_api="responses"\nenv_key="EMDASH_PROBE_KEY"\nhttp_headers={"X-Probe-Session"="one"}\n')
 env={**os.environ,'CODEX_HOME':str(home),'EMDASH_PROBE_KEY':'probe-client','OTEL_SDK_DISABLED':'true'}
 def run(args):
  p=subprocess.run(['codex','exec','--skip-git-repo-check','--json',*args],env=env,cwd=work,text=True,capture_output=True,timeout=40)
  assert p.returncode==0,(p.stdout,p.stderr)
  lines=[json.loads(l) for l in p.stdout.splitlines() if l.startswith('{')];assert any(l['type']=='turn.completed' for l in lines),lines
  return next(l['thread_id'] for l in lines if l['type']=='thread.started')
 route('a');first=run(['remember bluecar-v8-sdk'])
 route('b');second=run(['resume',first,'what was the token?'])
 assert first==second
 events=[json.loads(l) for l in pathlib.Path(boot['events']).read_text().splitlines()]
 assert any(e['kind']=='upstream' and e['provider']=='b' and 'bluecar-v8-sdk' in json.dumps(e['payload']) and 'what was the token?' in json.dumps(e['payload']) for e in events)
 print(json.dumps({'same_thread':True,'thread':first,'history_reached_b':True,'upstream':'SDK built-in Codex executor to loopback mocks'}))
