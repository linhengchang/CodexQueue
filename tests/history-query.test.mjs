import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queryHistory} from '../dist/shared/history-query.js';
const config={projectRoot:'/test'};
const filters={title:'',startDate:'',endDate:'',page:1,pageSize:10};
const task=(id,name,start)=>({id,name,startedAt:start,rawPrompt:'Billing hidden prompt',status:'completed'});
const batch=(id,tasks,createdAt='2026-11-01T00:00:00Z')=>({id,tasks,createdAt,config,status:'completed'});
const local=(day,hour=0,minute=0,second=0,ms=0)=>new Date(2026,10,day,hour,minute,second,ms).toISOString();
const ids=result=>result.groups.flatMap(group=>group.tasks.map(task=>task.id));
test('title search is trimmed, case-insensitive and does not match prompt content',()=>{
 const rows=[batch('a',[task('a','Billing 页面',local(11)),task('b','用户管理',local(11))])];
 assert.deepEqual(ids(queryHistory(rows,{...filters,title:'  BILLING  '})),['a']);
 assert.equal(queryHistory(rows,{...filters,title:'hidden prompt'}).total,0);
});
test('date filtering uses actual task start with inclusive local end day and excludes unstarted tasks',()=>{
 const rows=[batch('b',[task('before','before',local(10,23,59,59,999)),task('begin','begin',local(11)),task('end','end',local(11,23,59,59,999)),task('after','after',local(12)),task('not-started','not-started',undefined),task('bad','bad','invalid')],local(3))];
 assert.deepEqual(ids(queryHistory(rows,{...filters,startDate:'2026-11-11',endDate:'2026-11-11'})),['end','begin']);
 assert.deepEqual(ids(queryHistory(rows,{...filters,title:'begin',startDate:'2026-11-11'})),['begin']);
 assert.equal(queryHistory(rows,{...filters,endDate:'2026-11-11'}).total,3);
});
test('pagination limits tasks even within one batch and clamps when records shrink',()=>{
 const tasks=Array.from({length:25},(_,i)=>task(String(i),'task '+i,local(11,0,i)));
 const rows=[batch('big',tasks)];const first=queryHistory(rows,filters),second=queryHistory(rows,{...filters,page:2}),last=queryHistory(rows,{...filters,page:999});
 assert.equal(first.total,25);assert.equal(first.pages,3);assert.equal(first.groups[0].tasks.length,10);assert.equal(second.groups[0].tasks.length,10);assert.equal(last.page,3);assert.equal(last.groups[0].tasks.length,5);
 assert.equal(first.groups[0].matchedTasks,25);assert.equal(new Set([...ids(first),...ids(second),...ids(last)]).size,25);
 assert.equal(queryHistory([batch('small',[tasks[0]])],{...filters,page:3}).page,1);
 assert.equal(queryHistory(rows,{...filters,pageSize:20}).groups[0].tasks.length,20);
 assert.equal(queryHistory(rows,{...filters,pageSize:50}).groups[0].tasks.length,25);
});
test('matching task groups preserve original batch data and page actions can use only visible matches',()=>{
 const original=batch('a',[task('1','match A',local(11,1)),task('2','other',local(11,2)),task('3','match B',local(11,3))]);
 const result=queryHistory([original,batch('b',[task('4','match C',local(11,4))])],{...filters,title:'match'});
 assert.deepEqual(ids(result),['4','3','1']);assert.equal(result.matchingBatches,2);assert.equal(original.tasks.length,3);
 assert.deepEqual(result.groups.find(g=>g.batch.id==='a').tasks.map(t=>t.id),['3','1']);
});
test('invalid ranges and empty results do not silently fall back to unfiltered history',()=>{
 const rows=[batch('a',[task('1','test',local(11))])];
 const reverse=queryHistory(rows,{...filters,startDate:'2026-11-12',endDate:'2026-11-11'});assert.match(reverse.error,/开始日期不能晚于结束日期/);assert.equal(reverse.total,0);
 assert.match(queryHistory(rows,{...filters,startDate:'2026-02-30'}).error,/有效日期/);
 const empty=queryHistory(rows,{...filters,title:'missing',page:20});assert.equal(empty.page,1);assert.equal(empty.pages,1);assert.equal(empty.groups.length,0);
});
