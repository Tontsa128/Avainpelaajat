import {openDb} from './db.js';import {hashPassword} from './auth.js';import {newId} from './util.js';import process from 'node:process';
const [cmd,...args]=process.argv.slice(2);
async function main(){if(cmd!=='create-org'){console.error('Usage: node cli.js create-org "Org" email name password');process.exit(1);}
const [orgName,email,name,password]=args;if(!orgName||!email||!name||!password)throw new Error('Kaikki kentät vaaditaan.');
const db=openDb(process.env.DB_PATH||'./data/avainpelaaja.db');const oid=newId('o'),uid=newId('u');db.prepare('INSERT INTO organizations(id,name,settings,rev,created_at) VALUES(?,?,?,?,?)').run(oid,orgName,'{}',0,Date.now());db.prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(uid,email.toLowerCase(),name,await hashPassword(password),Date.now());db.prepare('INSERT INTO memberships(user_id,org_id,role) VALUES(?,?,?)').run(uid,oid,'Admin');console.log(JSON.stringify({orgId:oid,userId:uid},null,2));db.close();}
main().catch(e=>{console.error(e.message);process.exit(1);});
