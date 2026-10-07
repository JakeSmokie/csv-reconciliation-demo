"use strict";
const assert = require("node:assert/strict"), path=require("node:path"), fs=require("node:fs"), crypto=require("node:crypto");
const engine=require("./docs/reconciliation-engine.js");
const scenarios=require("./docs/scenarios.js");
const Papa=require("./docs/vendor/papaparse-5.7.0/papaparse.min.js");
const exp=(rows)=>Papa.unparse([["id","gross","commission","refund"],...rows],{newline:"\r\n"})+"\r\n";
const act=(rows)=>Papa.unparse([["id","actual_net"],...rows],{newline:"\r\n"})+"\r\n";
let passed=0;
async function test(name,fn){if(await fn()===false){console.log("SKIP "+name);return;}passed++;console.log("PASS "+name);}
async function rejects(expected,actual,code){await assert.rejects(engine.reconcile(expected,actual),e=>e.name==="InputError"&&e.code===code);}
(async()=>{
 await test("business manual oracle",async()=>{
  const s=scenarios[0],r=await engine.reconcile(s.expectedCSV,s.actualCSV,{expected:"C:\\private\\operations.csv",actual:"/private/payouts.csv"});
  assert.deepEqual(r.counts,{matched:8,mismatch:2,missing:2,unexpected:2});assert.equal(r.entries.length,14);
  assert.deepEqual(r.totals,{gross:"6060.00",commission:"605.00",refund:"240.00",expected_net:"5215.00",actual_net:"5135.00",delta:"-80.00",underpayment:"170.00",overpayment:"90.00"});
  assert.equal(r.inputs.expected.path,"operations.csv");assert.equal(r.inputs.actual.path,"payouts.csv");assert.equal(r.inputs.expected.sha256,crypto.createHash("sha256").update(s.expectedCSV).digest("hex"));
  assert.equal(r.entries.find(e=>e.id==="O012").status,"missing");assert.equal(r.entries.find(e=>e.id==="X002").status,"unexpected");
 });
 await test("zero total still includes cent errors/refunds",async()=>{
  const s=scenarios[1],r=await engine.reconcile(s.expectedCSV,s.actualCSV);assert.deepEqual(r.counts,{matched:3,mismatch:2,missing:1,unexpected:0});
  assert.deepEqual(r.totals,{gross:"140.29",commission:"4.59",refund:"27.10",expected_net:"108.60",actual_net:"108.60",delta:"0.00",underpayment:"0.01",overpayment:"0.01"});
 });
 await test("duplicate actual line 3/4 stops report",async()=>{
  const s=scenarios[2];await assert.rejects(engine.reconcile(s.expectedCSV,s.actualCSV),e=>e.code==="duplicate_id"&&e.firstLine===3&&e.line===4&&e.id==="D002");
  await rejects(exp([["D","1","0","0"],["D","1","0","0"]]),act([["D","1"]]),"duplicate_id");
 });
 await test("edited payout causes new non-static calculation",async()=>{
  const s=scenarios[0],r=await engine.reconcile(s.expectedCSV,s.actualCSV.replace("O009,340","O009,360"));assert.deepEqual(r.counts,{matched:9,mismatch:1,missing:2,unexpected:2});assert.equal(r.totals.actual_net,"5155.00");assert.equal(r.totals.delta,"-60.00");assert.equal(r.totals.underpayment,"150.00");
 });
 await test("quoted multi-lines and mixed CR/LF preserve physical provenance",async()=>{
  const expected='id,gross,commission,refund\r\n"A\r\nB",1,0,0\nC,2,0,0\r';
  const actual='id,actual_net\n"A\r\nB",1\r\nC,2';
  const r=await engine.reconcile(expected,actual);assert.equal(r.counts.matched,2);assert.equal(r.entries[0].id,"A\r\nB");assert.equal(r.entries[0].expected_source.line_start,2);assert.equal(r.entries[0].expected_source.line_end,3);assert.equal(r.entries[1].expected_source.line_start,4);assert.equal(r.entries[1].actual_source.line_start,4);
 });
 await test("trailing separator allowed; actual blank row rejected",async()=>{
  const r=await engine.reconcile("id,gross,commission,refund\n","id,actual_net\n");assert.equal(r.entries.length,0);assert.equal(r.totals.delta,"0.00");
  await rejects("id,gross,commission,refund\n\n","id,actual_net\n","cell_count");await rejects("id,gross,commission,refund\nA,1,0,0\n\n","id,actual_net\n","cell_count");
 });
 await test("single BOM allowed; double BOM and invalid UTF8 rejected",async()=>{
  const r=await engine.reconcile("\ufeff"+exp([["B","1","0","0"]]),"\ufeff"+act([["B","1"]]));assert.equal(r.counts.matched,1);
  await rejects("\ufeff\ufeff"+exp([]),act([]),"schema");await rejects(new Uint8Array([0xff]),act([]),"encoding");
 });
 await test("strict money, headers and cells",async()=>{
  for(const raw of ["NaN","Infinity","1e2","0.001","1,00","1 ","1\n","+","", "1000000000000000"]){await rejects(exp([["A",raw,"0","0"]]),act([]),raw==="1000000000000000"?"money_limit":"money_format");}
  await rejects("gross,id,commission,refund\n1,A,0,0\n",act([]),"schema");await rejects("id,gross,commission,refund\nA,1,0\n",act([]),"cell_count");await rejects(exp([["","1","0","0"]]),act([]),"empty_id");
  await rejects('id,gross,commission,refund\n"unfinished,1,0,0',act([]),"csv_syntax");
  await rejects('id,gross,commission,refund\n"A" ,1,0,0',act([]),"csv_syntax");
  await rejects('id,gross,commission,refund\n"A"\t,1,0,0',act([]),"csv_syntax");
 });
 await test("large boundary sums and rendering keep cents",async()=>{
  const r=await engine.reconcile(exp([["A","999999999999999.99","0","0"],["B","999999999999999.99","0","0"]]),act([["A","999999999999999.98"],["B","999999999999999.99"]]));assert.equal(r.totals.expected_net,"1999999999999999.98");assert.equal(r.totals.actual_net,"1999999999999999.97");assert.equal(r.totals.delta,"-0.01");assert.equal(engine.formatMoney(r.totals.expected_net),"1\u00a0999\u00a0999\u00a0999\u00a0999\u00a0999,98 ₽");
  assert.equal(engine.formatMoney("-0.00"),"0,00 ₽");assert.equal(engine.formatMoney("-5.00"),"−5,00 ₽");
 });
 await test("source exact identity and protected CSV formula/control IDs",async()=>{
  const ids=["=1+1","+SUM(1,1)","-2+3","@SUM(1,1)","\t=1+1","\r=1+1","\n=1+1"," =1+1","\x01=1+1","\ufeff=1+1","ordinary-id"];
  const r=await engine.reconcile(exp(ids.map(k=>[k,"1.00","0.10","0"])),act(ids.map(k=>[k,"0.90"])));assert.equal(r.counts.matched,ids.length);assert.deepEqual(r.entries.map(e=>e.id),ids);const exported=Papa.parse(engine.toCSV(r),{header:true,skipEmptyLines:true}).data;
  assert.deepEqual(exported.map(e=>e.id),ids.map((k,i)=>i<ids.length-1?"'"+k:k));assert.deepEqual(exported.map(e=>JSON.parse(e.expected_source_values_json).id),ids);assert.equal(exported[0].expected_line_start,String(r.entries[0].expected_source.line_start));
 });
 await test("ID whitespace/case significant; unexpected appended in actual order",async()=>{
  const r=await engine.reconcile(exp([["A","1","0","0"],[" A","2","0","0"]]),act([["a","3"],["A","1"]]));assert.deepEqual(r.entries.map(e=>e.id),["A"," A","a"]);assert.deepEqual(r.counts,{matched:1,mismatch:0,missing:1,unexpected:1});
 });
 await test("100000 records accepted; next record and 5MiB excess rejected",async()=>{
  const rows=[];for(let i=0;i<100000;i++)rows.push(["R"+i,"0","0","0"]);const r=await engine.reconcile(exp(rows),act([]));assert.equal(r.counts.missing,100000);rows.push(["overflow","0","0","0"]);await rejects(exp(rows),act([]),"row_limit");await rejects(new Uint8Array(5*1024*1024+1),act([]),"file_limit");
 });
 await test("optional complete report parity against independent Python CLI",async()=>{
  const {spawnSync}=require("node:child_process"), os=require("node:os");
  const python=process.env.PYTHON_EXECUTABLE||process.env.PYTHON||"python";
  const probe=spawnSync(python,["--version"],{encoding:"utf8"});
  if(probe.error||probe.status!==0){
   if(process.env.PYTHON_EXECUTABLE||process.env.PYTHON)throw new Error("Explicit Python probe failed");
   return false;
  }
  const base=fs.realpathSync(os.tmpdir()),temp=fs.mkdtempSync(path.join(base,"reconciliation-parity-"));
  try{
   const fixtures=[...scenarios.slice(0,2),{expectedCSV:exp([["A\r\nB","0.30","0.10","0.10"],["=1+1","999999999999999.99","0","0"]]),actualCSV:act([["A\r\nB","0.10"],["=1+1","999999999999999.98"]])}];
   for(let index=0;index<fixtures.length;index++){
    const fixture=fixtures[index],expected=path.join(temp,"expected-"+index+".csv"),actual=path.join(temp,"actual-"+index+".csv"),out=path.join(temp,"report-"+index);
    fs.writeFileSync(expected,fixture.expectedCSV,"utf8");fs.writeFileSync(actual,fixture.actualCSV,"utf8");
    const run=spawnSync(python,[path.join(__dirname,"reconcile.py"),expected,actual,"--out-dir",out],{encoding:"utf8"});
    if(run.status!==0)throw new Error("Python CLI fixture failed: "+run.stderr);
    const pythonReport=JSON.parse(fs.readFileSync(path.join(out,"report.json"),"utf8"));
    for(const input of Object.values(pythonReport.inputs))input.path=path.basename(input.path);
    for(const entry of pythonReport.entries)for(const side of ["expected_source","actual_source"])if(entry[side])entry[side].path=path.basename(entry[side].path);
    const browserReport=await engine.reconcile(fixture.expectedCSV,fixture.actualCSV,{expected:path.basename(expected),actual:path.basename(actual)});
    assert.deepEqual(browserReport,pythonReport);
   }
  }finally{
   // Delete only this exact freshly created test directory within the checked temp root.
   if(path.dirname(fs.realpathSync(temp))!==base)throw new Error("Unsafe test cleanup target");
   fs.rmSync(temp,{recursive:true,force:true});
  }
 });
 console.log(JSON.stringify({passed,live_requests:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});
