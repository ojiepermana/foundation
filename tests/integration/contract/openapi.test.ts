import { expect, test } from 'bun:test';
import { validateOpenApi } from '../../../scripts/validate-openapi';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root, run, workspace } from './workspace';
const valid = await Bun.file(join(root,'tests/fixtures/openapi/valid.json')).json();
const operation = (d: any) => d.paths['/api/status'].get;
// The fixture follows the current export: the 200 response references the DevelopmentStatus component (spec 0008).
const reference = (d: any) => operation(d).responses['200'].content['application/json'].schema;
const model = (d: any) => d.components.schemas.DevelopmentStatus;

test('APP-003 checker accepts exported contract and resolvable local references', () => {
  expect(() => validateOpenApi(valid)).not.toThrow();
  const d = structuredClone(valid);
  d.components.schemas.Failure={$id:'#/components/schemas/Failure',...structuredClone(operation(d).responses['500'].content['application/json'].schema)};
  operation(d).responses['500'].content['application/json'].schema={$ref:'#/components/schemas/Failure'};
  expect(() => validateOpenApi(d)).not.toThrow();
});
const violations: [string,(d:any)=>void][] = [
  ['version',d=>d.openapi='2.0'],['info',d=>delete d.info],['info title',d=>d.info.title=''],['info version',d=>delete d.info.version],
  ['paths',d=>delete d.paths],['required endpoint',d=>delete d.paths['/api/status']],['invalid path',d=>d.paths['bad']=d.paths['/api/status']],
  ['operationId',d=>delete operation(d).operationId],['duplicate operationId',d=>d.paths['/api/another']=structuredClone(d.paths['/api/status'])],
  ['tags',d=>delete operation(d).tags],['empty tags',d=>operation(d).tags=[]],['invalid tag',d=>operation(d).tags=[null]],
  ['security',d=>{delete operation(d).security;delete d.security}],['unknown security scheme',d=>operation(d).security=[{Unknown:[]}]],
  ['diagnostic authentication',d=>{d.components.securitySchemes={Bearer:{type:'http',scheme:'bearer'}};operation(d).security=[{Bearer:[]}]}],
  ['responses',d=>delete operation(d).responses],['empty responses',d=>operation(d).responses={}],['response description',d=>delete operation(d).responses['200'].description],
  ['response schema',d=>delete operation(d).responses['200'].content['application/json'].schema],['empty schema',d=>operation(d).responses['200'].content['application/json'].schema={}],
  ['wrong status literal',d=>model(d).properties.status.enum=['bad']],['extra status property',d=>model(d).properties.extra={type:'string'}],['additional status properties',d=>model(d).additionalProperties=true],
  ['unrequired status',d=>model(d).required=[]],['external reference',d=>reference(d).$ref='https://example.invalid/schema'],['missing local reference',d=>reference(d).$ref='#/components/schemas/Missing'],
  ['cyclic reference',d=>{d.components.schemas.Loop={type:'object',properties:{next:{$ref:'#/components/schemas/Loop'}}};model(d).properties.loop={$ref:'#/components/schemas/Loop'}}],
  ['query schema',d=>operation(d).parameters=[{name:'q',in:'query'}]],['path schema',d=>{d.paths['/api/{id}']={get:{...structuredClone(operation(d)),operationId:'getId'}}}],
  ['body schema',d=>operation(d).requestBody={content:{'application/json':{}}}],['empty body content',d=>operation(d).requestBody={content:{}}],
  ['invalid method',d=>d.paths['/api/status'].fetch={}],['invalid response status',d=>operation(d).responses.bad=structuredClone(operation(d).responses['200'])],
];
for (const [name,mutate] of violations) test(`APP-003 checker rejects ${name}`, () => {const d=structuredClone(valid);mutate(d);expect(()=>validateOpenApi(d)).toThrow();});
for (const input of [null,[],true,'invalid']) test(`APP-003 checker rejects nonobject ${JSON.stringify(input)}`,()=>expect(()=>validateOpenApi(input)).toThrow());

test('APP-003 validation CLI rejects malformed JSON with safe nonzero exit', async () => {
  const p=Bun.spawn([process.execPath,'--no-env-file','scripts/validate-openapi.ts','tests/fixtures/openapi/malformed.json'],{cwd:root,stdout:'pipe',stderr:'pipe'});
  expect(await p.exited).toBe(1);expect((await new Response(p.stderr).text()).trim()).toBe('OpenAPI validation failed');
});

test('APP-003 stored contract and SDK reproduce without ports or database', async () => {
  const dir=await workspace();try {const result=await run(dir,'api:check',{timeout:150_000});expect(result.code, result.output).toBe(0);expect(result.output).toContain('across two runs');}finally{await rm(dir,{recursive:true,force:true});}
},180_000);
for(const change of ['changed','missing','new','new-unowned'] as const) {
  test(`APP-003 api:check rejects ${change} generated artifacts`,async()=>{
    const dir=await workspace();try {
      const path=join(dir,'apps/frontend/sdk/api.ts');
      if(change==='changed')await Bun.write(path,(await Bun.file(path).text())+'\n// drift\n');
      if(change==='missing')await rm(path);
      if(change==='new-unowned')await Bun.write(join(dir,'apps/frontend/sdk/unowned-extra.ts'),'// extra file outside generator manifest\n');
      if(change==='new'){
        const manifest=join(dir,'apps/frontend/sdk/.ojiepermana-sdk-manifest.json');const value=await Bun.file(manifest).json();value.files.push('obsolete.ts');await Bun.write(manifest,JSON.stringify(value));await Bun.write(join(dir,'apps/frontend/sdk/obsolete.ts'),'// obsolete generated file\n');
      }
      const result=await run(dir,'api:check',{timeout:150_000});expect(result.code).not.toBe(0);expect(result.output).toContain('drift detected');
    }finally{await rm(dir,{recursive:true,force:true});}
  },180_000);
}
for(const stage of ['api:openapi','api:validate','sdk:generate']) {
  test(`APP-003 api:sync stops when ${stage} fails`,async()=>{
    const dir=await workspace();try {
      const file=join(dir,'package.json');const p=await Bun.file(file).json();
      const stages=['api:openapi','api:validate','sdk:generate'];
      for(const name of stages)p.scripts[name]=`bun -e 'await Bun.write("${name.replace(':','-')}.marker", "ran"); process.exit(${name===stage?7:0})'`;
      await Bun.write(file,JSON.stringify(p));const result=await run(dir,'api:sync');expect(result.code).not.toBe(0);
      for(const name of stages)expect(await Bun.file(join(dir,name.replace(':','-')+'.marker')).exists()).toBe(stages.indexOf(name)<=stages.indexOf(stage));
    }finally{await rm(dir,{recursive:true,force:true});}
  },10000);
}

test('APP-003 generated status type accepts ok and rejects other values', async () => {
  const dir = await workspace();
  try {
    await Bun.write(join(dir, 'sdk-consumer.ts'), `import type { DevelopmentStatus } from './apps/frontend/sdk/public-api';
const valid: DevelopmentStatus = {status: 'ok'};
// @ts-expect-error The generated contract must reject values outside the response literal.
const invalid: DevelopmentStatus = {status: 'unexpected'};
void valid; void invalid;
`);
    const p = Bun.spawn(['node',join(root,'node_modules/typescript/bin/tsc'),'--strict','--noEmit','--skipLibCheck','--moduleResolution','bundler','--module','preserve','--target','es2022','sdk-consumer.ts'], {cwd:dir,stdout:'pipe',stderr:'pipe'});
    const [code,out,err] = await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
    expect(code,out+err).toBe(0);
  } finally {await rm(dir,{recursive:true,force:true});}
},10000);
