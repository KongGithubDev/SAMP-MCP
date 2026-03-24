# SAMP Project Rules (Universal)
MANDATORY for Windsurf, Cursor, Antigravity, and all AI Agents:

1. **ENCODING (CRITICAL)**:
   - This project uses **Thai (Windows-874)** or **Universal Auto-Detection**.
   - **NEVER** use built-in tools like 'read_file', 'write_file', or 'grep' on .pwn or .inc files.
   - **MANDATORY**: You **MUST** use the following SAMP-MCP tools:
     - 'read_pawn_script': To read source code safely.
     - 'write_pawn_script': To save code without corruption.
     - 'fix_script_encoding': Use immediately if you see garbage (เธเธ) in any file.

2. **LANGUAGE PRESERVATION**:
   - **DO NOT** translate strings. Maintain the original project language.

3. **COMPILATION**:
   - Use 'compile_and_load_pawn' to verify changes and reload server.

FAILURE TO USE SAMP-MCP TOOLS WILL CAUSE PERMANENT DATA CORRUPTION.
