import { PawnManager } from './src/scripts.js';

async function fix() {
    const pawn = new PawnManager();
    pawn.serverRoot = 'C:\\Users\\kongw\\OneDrive\\Desktop\\Sc UR New';
    
    // Read files
    const banana = await pawn.readScript('gamemodes/Newjob/autojob/auto_banana.pwn');
    const juice = await pawn.readScript('gamemodes/Newjob/autojob/auto_juice.pwn');
    
    console.log('--- BANANA (Correct) ---');
    console.log(banana);
    console.log('--- JUICE (Current) ---');
    console.log(juice);
}

fix();
