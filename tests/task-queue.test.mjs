import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/server/store.js';
import {Storage} from '../dist/server/storage.js';
import {defaultSettings} from '../dist/shared/types.js';
import {restoreHistoryTasks,remainingTasks} from '../dist/shared/task-queue.js';
import {worktreeDirectory} from '../dist/server/worktree-directory.js';
const task=()=>({id:randomUUID(),name:'历史任务',branch:'ai/task',rawPrompt:'保留原文\n按钮：查询',images:['a'.repeat(64)]});
test('legacy reusable tasks migrate once, preserving edited tasks and history with a backup',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'auto-work-queue-'));await mkdir(path.join(root,'data'));
 const settings=structuredClone(defaultSettings);settings.config.projectRoot=root;const a=task(),b=task();settings.tasks=[a,{...b,rawPrompt:'edited requirement'}];
 const batch={id:randomUUID(),status:'failed',config:settings.config,tasks:[a,b]};
 const legacy={settings,batches:[batch],schedule:{enabled:false}};await writeFile(path.join(root,'data/state.json'),JSON.stringify(legacy));
 const store=new Store(root);await store.init();assert.equal(store.settings.tasks.length,1);assert.equal(store.settings.tasks[0].rawPrompt,'edited requirement');assert.equal(store.batches[0].tasks.length,2);
 assert.deepEqual(JSON.parse(await readFile(path.join(root,'data/backups/state-before-queue-v2.json'),'utf8')),legacy);
 const again=new Store(root);await again.init();assert.equal(again.settings.tasks.length,1);
});
test('legacy daily schedule retains its tasks when migrating to an empty pending queue',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'auto-work-schedule-'));await mkdir(path.join(root,'data'));const settings=structuredClone(defaultSettings);settings.tasks=[task()];settings.config.projectRoot=root;
 await writeFile(path.join(root,'data/state.json'),JSON.stringify({settings,batches:[],schedule:{enabled:true}}));
 const store=new Store(root);await store.init();assert.equal(store.settings.tasks.length,0);assert.deepEqual(store.schedule.snapshot.tasks,settings.tasks);assert.equal(store.schedule.enabled,true);
});
test('history restore creates editable tasks with fresh IDs and protects a different project queue',()=>{
 const current=structuredClone(defaultSettings);current.config.projectRoot='/project-a';const original={...task(),status:'failed',worktree:'/old/code'};const config={...current.config,model:'saved-model'};const history={status:'failed',config,tasks:[original]};
 const next=restoreHistoryTasks(current,history,[original.id],randomUUID);assert.notEqual(next.tasks[0].id,original.id);assert.equal(next.tasks[0].rawPrompt,original.rawPrompt);assert.deepEqual(next.tasks[0].images,original.images);assert.equal(next.tasks[0].worktree,undefined);assert.equal(next.config.model,'saved-model');assert.equal(current.tasks.length,0);
 next.tasks[0].images.push('b'.repeat(64));assert.equal(original.images.length,1);
 current.tasks=[task()];current.config.projectRoot='/different-project';assert.throws(()=>restoreHistoryTasks(current,history,[original.id],randomUUID),/其他项目/);
 assert.equal(remainingTasks([{...original,rawPrompt:'new edit'}],[original]).length,1);assert.equal(remainingTasks([original],[original]).length,0);
});
test('scheduled attachment references survive history cleanup protection',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'auto-work-ref-'));const store=new Store(root);const image=task().images[0];store.schedule.snapshot={...structuredClone(defaultSettings),tasks:[{...task(),images:[image]}]};
 assert.ok(new Storage(store).referenced().has(image));store.schedule.snapshot=null;assert.equal(new Storage(store).referenced().has(image),false);
});
test('directory lookup opens only recorded worktree paths and reports missing directories',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'auto-work-open-'));const store=new Store(root);const project=path.join(root,'business');const batchId=randomUUID(),t=task();const base=path.join(root,'.auto-work-worktrees','business');const directory=path.join(base,batchId,t.id);await mkdir(directory,{recursive:true});
 store.batches=[{id:batchId,status:'completed',config:{...defaultSettings.config,projectRoot:project},tasks:[{...t,worktree:directory}]}];
 assert.equal(await worktreeDirectory(store,batchId,t.id),directory);assert.equal(await worktreeDirectory(store,batchId),base);
 store.batches[0].tasks[0].worktree=root;await assert.rejects(worktreeDirectory(store,batchId,t.id),/不匹配/);
 store.batches[0].tasks[0].worktree=directory;await rm(directory,{recursive:true});await assert.rejects(worktreeDirectory(store,batchId,t.id),/不存在/);
});
