import json,urllib.request,urllib.error,pathlib,time,concurrent.futures
boot=json.loads(pathlib.Path('/tmp/emdash-sdk-validation/v8-boot.json').read_text());base=boot['url']
def request(path,method='GET',body=None,key='probe-management',headers={}):
 req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json',**headers})
 try:
  with urllib.request.urlopen(req,timeout=10) as r:return r.status,r.read().decode()
 except urllib.error.HTTPError as e:return e.code,e.read().decode()
def stream(session,expected):
 code,body=request('/v1/responses','POST',{'model':'test','input':'probe','stream':True},key='probe-client',headers={'X-Probe-Session':session})
 assert code==200 and 'hello '+expected in body,(code,body)
 return {'session':session,'provider':expected,'status':code}
baseline=len(pathlib.Path(boot['events']).read_text().splitlines()) if pathlib.Path(boot['events']).exists() else 0
assert request('/probe/routes/one/a','PUT')[0]==204
assert request('/probe/routes/two/a','PUT')[0]==204
assert request('/v8/management/config')[0]==200
assert request('/v8/management/config',key='bad')[0]==401
assert request('/v1/responses','POST',{'model':'test','input':'probe','stream':True},key='bad',headers={'X-Probe-Session':'one'})[0]==401
results=[stream('one','a')]
assert request('/probe/routes/one/b','PUT')[0]==204
results += [stream('one','b'),stream('two','a')]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 results+=list(pool.map(lambda v:stream(*v),[('one','b'),('two','a')]*3))
assert request('/v1/responses','POST',{'model':'test','input':'probe','stream':True},key='probe-client',headers={'X-Probe-Session':'missing'})[0]==400
# Same selected SDK backend, actual streaming cancellation reaches mock HTTP upstream.
q=urllib.request.Request(base+'/v1/responses',data=json.dumps({'model':'test','input':'WAIT_FOR_CANCEL','stream':True}).encode(),headers={'Authorization':'Bearer probe-client','Content-Type':'application/json','X-Probe-Session':'one'})
r=urllib.request.urlopen(q,timeout=10);r.readline();r.close()
for _ in range(30):
 events=[json.loads(l) for l in pathlib.Path(boot['events']).read_text().splitlines()[baseline:]]
 if any(e['kind']=='cancelled' for e in events):break
 time.sleep(.1)
else:raise AssertionError('cancellation did not reach upstream')
usage=[e for e in events if e['kind']=='usage' and not e['failed']]
assert len(usage)>=9 and all(e['input']==7 and e['output']==3 and e['request'] for e in usage),usage
assert all(e['authOK'] for e in events if e['kind']=='upstream')
assert request('/v8/management/config/routing/retry/request-retry','PUT',1)[0]==200
assert json.loads(request('/v8/management/config')[1])['routing']['retry']['request-retry']==1
assert 'request-retry: 1' in pathlib.Path(boot['config']).read_text()
assert request('/v8/management/config/routing/retry/request-retry','PUT',0)[0]==200
assert request('/v8/management/oauth/auth-url?provider=unknown')[0]==404
assert request('/v8/management/oauth/callback','POST',{'provider':'codex','state':'not-pending','code':'fake-code'})[0] in [400,404]
print(json.dumps({'routes':results,'successful_usage_records':len(usage),'upstream_cancellation':True,'management_write_read':True,'invalid_oauth_rejected':True}))
pathlib.Path('/tmp/emdash-sdk-validation/runtime-result.json').write_text(json.dumps({'routes':results,'usage_count':len(usage),'cancellation':True}))
