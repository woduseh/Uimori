import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { convertRisuJson, type RisuImportResult } from '../core/risu-import.js';

export const RISU_IMPORT_LIMITS={inputBytes:16*1024*1024,jsonBytes:4*1024*1024,entryCount:2000,entryBytes:16*1024*1024,totalBytes:64*1024*1024};
const decode=(value:Uint8Array)=>new TextDecoder('utf-8',{fatal:true}).decode(value);
/** Inspect the central directory first. Nothing is written to disk or fetched remotely. */
function cardFromZip(bytes:Uint8Array){
  const buffer=Buffer.from(bytes);let end=-1;
  for(let offset=buffer.length-22;offset>=Math.max(0,buffer.length-65557);offset--)if(buffer.readUInt32LE(offset)===0x06054b50&&offset+22+buffer.readUInt16LE(offset+20)===buffer.length){end=offset;break;}
  if(end<0)throw new Error('ZIP end record missing');
  if(buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6)||buffer.readUInt16LE(end+8)!==buffer.readUInt16LE(end+10))throw new Error('Multi-disk ZIP is unsupported');
  const count=buffer.readUInt16LE(end+10),directorySize=buffer.readUInt32LE(end+12),directoryOffset=buffer.readUInt32LE(end+16);
  if(count>RISU_IMPORT_LIMITS.entryCount||count===65535||directoryOffset+directorySize!==end)throw new Error('ZIP directory exceeds limits or uses unsupported layout');
  const entries:{name:string;size:number}[]=[];const names=new Set<string>();let position=directoryOffset,total=0;let card:Buffer|undefined;
  for(let index=0;index<count;index++){
    if(position+46>end||buffer.readUInt32LE(position)!==0x02014b50)throw new Error('Invalid ZIP central entry');
    const flags=buffer.readUInt16LE(position+8),method=buffer.readUInt16LE(position+10),crc=buffer.readUInt32LE(position+16),compressed=buffer.readUInt32LE(position+20),size=buffer.readUInt32LE(position+24),nameLength=buffer.readUInt16LE(position+28),extraLength=buffer.readUInt16LE(position+30),commentLength=buffer.readUInt16LE(position+32),local=buffer.readUInt32LE(position+42);
    if(buffer.readUInt16LE(position+34)!==0||(index===0&&local!==0))throw new Error('Multi-disk or prefixed ZIP is unsupported');
    if(position+46+nameLength+extraLength+commentLength>end)throw new Error('Truncated ZIP name');
    const name=decode(buffer.subarray(position+46,position+46+nameLength));position+=46+nameLength+extraLength+commentLength;
    if(!name||name.startsWith('/')||name.includes('\\')||name.includes(':')||name.includes('\0')||name.split('/').includes('..')||names.has(name))throw new Error('Unsafe or duplicate ZIP name');
    names.add(name);total+=size;if(size>RISU_IMPORT_LIMITS.entryBytes||total>RISU_IMPORT_LIMITS.totalBytes||flags&1||![0,8].includes(method))throw new Error('ZIP compression or resource limit unsupported');
    if(local+30>directoryOffset||buffer.readUInt32LE(local)!==0x04034b50)throw new Error('Invalid ZIP local entry');
    const localNameLength=buffer.readUInt16LE(local+26),localExtra=buffer.readUInt16LE(local+28),start=local+30+localNameLength+localExtra;
    if(start+compressed>directoryOffset||decode(buffer.subarray(local+30,local+30+localNameLength))!==name||buffer.readUInt16LE(local+8)!==method||buffer.readUInt16LE(local+6)!==flags)throw new Error('ZIP metadata mismatch');
    entries.push({name,size});
    if(name==='card.json'){
      if(size>RISU_IMPORT_LIMITS.jsonBytes)throw new Error('card.json exceeds limit');
      const payload=buffer.subarray(start,start+compressed);card=method===0?Buffer.from(payload):inflateRawSync(payload,{maxOutputLength:RISU_IMPORT_LIMITS.jsonBytes});
      if(card.length!==size||crc32(card)!==crc)throw new Error('card.json size or CRC mismatch');
    }
  }
  if(position!==end||!card)throw new Error('card.json missing or directory size mismatch');
  return {card,entries};
}

export async function inspectRisuImport({fileName,bytes}:{fileName:string;bytes:Uint8Array}):Promise<RisuImportResult>{
  const name=typeof fileName==='string'?fileName.replace(/^.*[\\/]/,'').slice(0,200):'import';
  const extension=name.toLowerCase().split('.').at(-1);const kind=extension==='risup'||extension==='risupreset'?'prompt':'content';
  const original={fileName:name,byteLength:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex'),format:extension??'unknown'};
  const blocked=(message:string):RisuImportResult=>({kind,issues:[{severity:'blocking',path:'$',message}],original});
  if(!bytes.byteLength||bytes.byteLength>RISU_IMPORT_LIMITS.inputBytes)return blocked('파일이 비어 있거나 입력 16 MiB 한도를 넘었어요.');
  if(extension==='risup'||extension==='risupreset'||extension==='risum')return blocked('RPack/MessagePack/암호화 컨테이너는 아직 지원하지 않아요. RisuToki 구조화 도구 또는 Risuai의 JSON 내보내기를 사용해 주세요. 원본 파일을 임의 해제하거나 실행하지 않았어요.');
  try{
    let jsonBytes=bytes;let entries:{name:string;size:number}[]|undefined;
    if(extension==='charx'){const zip=cardFromZip(bytes);jsonBytes=zip.card;entries=zip.entries;}
    if(jsonBytes.byteLength>RISU_IMPORT_LIMITS.jsonBytes)return blocked('JSON 4 MiB 한도를 넘었어요.');
    const result=convertRisuJson(JSON.parse(decode(jsonBytes)));result.original={...original,...(entries?{entries}:{})};
    for(const entry of entries??[])if(entry.name!=='card.json')result.issues.push({severity:entry.name==='module.risum'?'blocking':'warning',path:`archive/${entry.name}`,message:entry.name==='module.risum'?'포함된 module.risum은 변환하지 않았어요. 별도 JSON 추출이 필요해요.':'포함 에셋/부가 파일은 저장·실행하지 않았어요. 파일 이름과 크기만 보존했어요.'});
    return result;
  }catch(error){return blocked(`읽기 또는 변환을 중단했어요: ${error instanceof Error?error.message:'잘못된 파일'}`);}
}
