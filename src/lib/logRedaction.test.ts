import {test} from 'node:test'
import assert from 'node:assert/strict'
import {redactLog} from './logRedaction.ts'
test('logs retain diagnosis without raw mail addresses or credentials',()=>{
 const message=redactLog(new Error('Provider failed for player+test@example.com Bearer private-token re_private123 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'))
 for(const secret of ['player+test@example.com','private-token','re_private123','eyJhbGci']) assert.equal(message.includes(secret),false)
 assert.match(message,/Provider failed/)
 assert.equal(redactLog('x'.repeat(1000)).length,500)
})
