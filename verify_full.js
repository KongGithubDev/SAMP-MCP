import { PawnManager } from './dist/scripts.js';
import * as path from 'path';

async function verify() {
    const pawn = new PawnManager();
    const mockRoot = path.resolve('./mock-server');
    
    console.log(`--- Starting Verification in ${mockRoot} ---`);
    
    const tests = [
        { name: 'detectFromRoot', fn: () => pawn.detectFromRoot(mockRoot) },
        { name: 'readConfig', fn: () => pawn.readConfig() },
        { name: 'listDirectory', fn: () => pawn.listDirectory('.') },
        { name: 'inspectProject', fn: () => pawn.inspectProject() },
        { name: 'generateDocs', fn: () => pawn.generateDocs() },
        { name: 'checkIncludes', fn: () => pawn.checkIncludes() },
        { name: 'listIncludes', fn: () => pawn.listIncludes() },
        { name: 'checkMcpUpdate', fn: () => pawn.checkMcpUpdate("1.0.3") },
    ];

    let passed = 0;
    for (const test of tests) {
        try {
            console.log(`Testing ${test.name}...`);
            const res = await test.fn();
            console.log(`✅ ${test.name} passed.`);
            // console.log('Result:', JSON.stringify(res, null, 2).substring(0, 100) + '...');
            passed++;
        } catch (e) {
            console.error(`❌ ${test.name} failed:`, e.message);
        }
    }

    console.log(`--- Final Result: ${passed}/${tests.length} tests passed ---`);
    if (passed === tests.length) {
        console.log("READY FOR PUBLISH");
    } else {
        process.exit(1);
    }
}

verify();
