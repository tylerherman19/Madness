import {test} from 'node:test'
import assert from 'node:assert/strict'
import {centralClock, reminderWindow, retryDelay, operationIsStale, orderRecoveryDates, turnoverCaughtUp} from './operationPolicy.ts'
test('Central worker clock preserves 3 AM across both DST transitions',()=>{
 for(const instant of ['2026-03-08T08:00:00Z','2026-11-01T09:00:00Z']) assert.equal(centralClock(new Date(instant)).hour,3)
 assert.equal(centralClock(new Date('2026-11-01T08:00:00Z')).hour,2)
})
test('reminder windows follow deadline and never send after lock',()=>{
 const lock=new Date('2026-10-17T18:00:00Z')
 for(const [minutes,expected] of [[121,null],[120,'2h'],[31,'2h'],[30,'30m'],[1,'30m'],[0,null],[-1,null]] as const) assert.equal(reminderWindow(lock,new Date(lock.getTime()-minutes*60_000)),expected)
})
test('retries back off and cap; missing/stale heartbeats fail health',()=>{
 assert.equal(retryDelay(1),60);assert.equal(retryDelay(8),3600)
 const now=new Date('2026-10-17T18:00:00Z')
 assert.equal(operationIsStale(null,now,10),true)
 assert.equal(operationIsStale('2026-10-17T17:49:00Z',now,10),true)
 assert.equal(operationIsStale('2026-10-17T17:55:00Z',now,10),false)
})

test('permanently unresolved old dates cannot starve never-checked dates',()=>{
 const rows=[{slate_date:'2026-01-01',result_checked_at:'2026-10-17T08:00:00Z'},{slate_date:'2026-01-02',result_checked_at:null}]
 assert.equal(orderRecoveryDates(rows,true)[0].slate_date,'2026-01-02')
 assert.equal(orderRecoveryDates(rows,false)[0].slate_date,'2026-01-01')
})

test('turnover remains retryable until recovery reaches today or no active day remains',()=>{
 const today='2026-10-17'
 for(const [label,result,expected] of [
  ['older day after one recovery step',{advanced_to:'2026-10-16'},false],
  ['advanced to today',{advanced_to:today},true],
  ['advanced to a future playing day',{advanced_to:'2026-10-19'},true],
  ['today or future day already active',{caught_up:true},true],
  ['no active day',{caught_up:true},true],
  ['awaiting results without advancement',{},false],
  ['caught-up state is false',{caught_up:false},false],
  ['unrecognized advanced day',{advanced_to:null},false],
 ] as const) assert.equal(turnoverCaughtUp(result,today),expected,label)
})
