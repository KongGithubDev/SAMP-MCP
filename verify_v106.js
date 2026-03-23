import { PawnManager } from './dist/scripts.js';
import * as fs from 'fs/promises';
import * as path from 'path';

async function testV106() {
    const pawn = new PawnManager();
    const testDir = path.resolve('./test-v106');
    await fs.mkdir(testDir, { recursive: true });
    
    // Testing the 'blind' typo which was causing the issue in the user's screenshot
    await fs.writeFile(path.join(testDir, 'server.cfg'), 'blind 168.222.20.193\nport 7777\nrcon_password secret');
    
    console.log('--- Testing v1.0.6 Bind/Blind Detection ---');
    const res = await pawn.detectFromRoot(testDir);
    console.log('Result:', JSON.stringify(res, null, 2));
    
    if (res.host === '168.222.20.193') {
        console.log('✅ SUCCESS: Correctly detected IP from "blind" typo!');
    } else {
        console.error('❌ FAILED: Did not detect IP from "blind" typo. Result:', res.host);
        process.exit(1);
    }
    
    await fs.rm(testDir, { recursive: true });
}

testV106();
