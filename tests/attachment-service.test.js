const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { uploadAttachment, getAttachment, rememberAttachment, ensureSpreadsheetSemanticExtraction } = require('../src/services/attachment-service');

async function seedMemoryRoot(baizeRoot) {
  await fs.mkdir(path.join(baizeRoot, 'memory', 'shallow'), { recursive: true });
  await fs.mkdir(path.join(baizeRoot, 'memory', 'deep', 'indexes'), { recursive: true });
}

describe('attachment service', () => {
  it('stores and analyzes uploaded text files', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));

    const attachment = await uploadAttachment({
      fileName: 'notes.md',
      mimeType: 'text/markdown',
      contentBase64: Buffer.from('# 项目说明\n白泽需要记住这段内容。').toString('base64'),
      conversationId: 'conversation-1',
      clientId: 'desktop-1'
    }, { baizeRoot });

    expect(attachment).toMatchObject({
      fileName: 'notes.md',
      type: 'text',
      conversationId: 'conversation-1',
      clientId: 'desktop-1',
      memory: { status: 'pending_confirmation', category: 'project' }
    });
    expect(attachment.analysis.summary).toContain('白泽需要记住');
    await expect(fs.access(path.join(baizeRoot, 'uploads', attachment.id, 'notes.md'))).resolves.toBeUndefined();
  });

  it('stores and analyzes uploaded xlsx files', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 标题: 'JUMP需求收集表', 项目: 'BATTLE', 负责人: '曾浩然' }
    ]), '需求');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const attachment = await uploadAttachment({
      fileName: 'JUMP需求收集表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: buffer.toString('base64'),
      conversationId: 'conversation-xlsx',
      clientId: 'desktop-1'
    }, { baizeRoot });

    expect(attachment).toMatchObject({
      fileName: 'JUMP需求收集表.xlsx',
      type: 'spreadsheet',
      memory: { status: 'pending_confirmation', category: 'project' }
    });
    expect(attachment.analysis.summary).toContain('收到表格文件');
    expect(attachment.analysis.summary).not.toContain('当前版本不会解析二进制内容');
    expect(attachment.analysis.extractedText).toContain('工作表：需求');
    expect(attachment.analysis.extractedText).toContain('JUMP需求收集表');
    expect(attachment.analysis.extractedText).toContain('BATTLE');
  });

  it('extracts high-fidelity spreadsheet context and reuses cache', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['模块', '需求内容', '负责人'],
      ['战斗', 'JUMP 战斗结算优化', '曾浩然']
    ]);
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    XLSX.utils.book_append_sheet(workbook, sheet, '需求池');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const attachment = await uploadAttachment({
      fileName: 'JUMP需求收集表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: buffer.toString('base64'),
      conversationId: 'conversation-xlsx-cache',
      clientId: 'desktop-1'
    }, { baizeRoot });

    const metadata = await getAttachment(attachment.id, { baizeRoot });
    const first = await ensureSpreadsheetSemanticExtraction(metadata, { baizeRoot });
    const second = await ensureSpreadsheetSemanticExtraction(metadata, { baizeRoot });

    expect(first).toMatchObject({ kind: 'xlsx_semantic_text', source: 'server', cached: false, sheetCount: 1 });
    expect(first.text).toContain('工作表：需求池');
    expect(first.text).toContain('范围：A1:C2');
    expect(first.text).toContain('合并单元格：A1:B1');
    expect(first.text).toContain('R2 | A(A2)=战斗');
    expect(first.text).toContain('B(B2)=JUMP 战斗结算优化');
    expect(second).toMatchObject({ kind: 'xlsx_semantic_text', cached: true });
  });

  it('stores archive uploads as pending extractable memory', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));

    const attachment = await uploadAttachment({
      fileName: 'AIDebug.7z',
      mimeType: 'application/x-7z-compressed',
      contentBase64: Buffer.from('fake-archive').toString('base64'),
      conversationId: 'conversation-archive'
    }, { baizeRoot });

    expect(attachment).toMatchObject({
      fileName: 'AIDebug.7z',
      type: 'archive',
      memory: { status: 'pending_confirmation', category: 'project' }
    });
    expect(attachment.analysis.summary).toContain('收到压缩文件');
    expect(attachment.analysis.reason).toContain('解压');
  });

  it('extracts archive attachments into memory on confirmation', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));
    await seedMemoryRoot(baizeRoot);
    const attachment = await uploadAttachment({
      fileName: 'AIDebug.7z',
      mimeType: 'application/x-7z-compressed',
      contentBase64: Buffer.from('fake-archive').toString('base64')
    }, { baizeRoot });
    const extractedDir = path.join(baizeRoot, 'uploads', attachment.id, 'extracted');
    const archiveExtractor = vi.fn(async () => {
      await fs.mkdir(extractedDir, { recursive: true });
      await fs.writeFile(path.join(extractedDir, 'debug.md'), '# 调试记录\n白泽需要记住 AIDebug。', 'utf8');
      return {
        extractedDir,
        files: [{
          path: path.join(extractedDir, 'debug.md'),
          relativePath: 'debug.md',
          size: 34,
          preview: '调试记录 白泽需要记住 AIDebug。'
        }]
      };
    });

    const remembered = await rememberAttachment(attachment.id, { category: 'project' }, { baizeRoot, archiveExtractor });

    expect(archiveExtractor).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'AIDebug.7z' }));
    expect(remembered.memory.status).toBe('remembered');
    expect(remembered.extraction.fileCount).toBe(1);
    await expect(fs.readFile(path.join(baizeRoot, 'memory', 'shallow', 'project.md'), 'utf8')).resolves.toContain('debug.md');
    await expect(fs.readFile(path.join(baizeRoot, 'memory', 'shallow', 'project.md'), 'utf8')).resolves.toContain('AIDebug');
    await expect(fs.readFile(path.join(baizeRoot, 'memory', 'deep', 'indexes', 'project-index.md'), 'utf8')).resolves.toContain('extracted');
  });

  it('adds confirmed attachments to shallow and deep memory', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));
    await seedMemoryRoot(baizeRoot);
    const attachment = await uploadAttachment({
      fileName: 'context.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('这是需要加入记忆区的上下文。').toString('base64')
    }, { baizeRoot });

    const remembered = await rememberAttachment(attachment.id, { category: 'project' }, { baizeRoot });

    expect(remembered.memory.status).toBe('remembered');
    await expect(fs.readFile(path.join(baizeRoot, 'memory', 'shallow', 'project.md'), 'utf8')).resolves.toContain('这是需要加入记忆区的上下文');
    await expect(fs.readFile(path.join(baizeRoot, 'memory', 'deep', 'indexes', 'project-index.md'), 'utf8')).resolves.toContain('context.txt');
  });

  it('ignores upload-time image analysis and keeps images pending for remember-time vision', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));

    const attachment = await uploadAttachment({
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-png').toString('base64'),
      conversationId: 'conversation-image',
      clientAnalysis: {
        provider: 'local_claude_code',
        summary: '图片显示一个白泽客户端错误弹窗。',
        memoryCategory: 'project',
        shouldRemember: true,
        reason: '图片包含客户端调试上下文，建议加入记忆区。',
        extractedText: '连接服务器失败',
        localPath: 'D:/secret/screenshot.png',
        token: 'secret-token'
      }
    }, { baizeRoot });

    expect(attachment).toMatchObject({
      fileName: 'screenshot.png',
      type: 'image',
      analysis: {
        provider: 'local_claude_code_pending',
        summary: '图片已上传：screenshot.png，大小 8 字节。',
        extractedText: ''
      },
      memory: { status: 'pending_confirmation', category: 'project' }
    });
    expect(JSON.stringify(attachment)).not.toContain('图片显示一个白泽客户端错误弹窗');
    expect(JSON.stringify(attachment)).not.toContain('D:/secret');
    expect(JSON.stringify(attachment)).not.toContain('secret-token');
  });

  it('keeps image uploads with neutral fallback when client analysis is unavailable', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));

    const attachment = await uploadAttachment({
      fileName: 'fallback.jpg',
      mimeType: 'image/jpeg',
      contentBase64: Buffer.from('fake-jpg').toString('base64')
    }, { baizeRoot });

    expect(attachment.type).toBe('image');
    expect(attachment.analysis.provider).toBe('local_claude_code_pending');
    expect(attachment.analysis.summary).toContain('图片已上传');
    expect(attachment.analysis.reason).toContain('点击加入记忆区后');
    expect(attachment.analysis.summary).not.toContain('视觉分析暂不可用');
    expect(attachment.analysis.summary).not.toContain('API Key');
    expect(attachment.analysis.reason).not.toContain('Auth Token');
  });

  it('rejects image memory when visual analysis is still pending', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));
    await seedMemoryRoot(baizeRoot);
    const attachment = await uploadAttachment({
      fileName: 'pending.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-png').toString('base64')
    }, { baizeRoot });

    await expect(rememberAttachment(attachment.id, { category: 'project' }, { baizeRoot })).rejects.toMatchObject({
      code: 'IMAGE_ANALYSIS_REQUIRED',
      publicMessage: '图片加入记忆区前必须完成本机 Claude Code 视觉分析。请确认客户端本机 Claude Code 可用后重试。'
    });
  });

  it('adds confirmed image analysis to deep memory while shallow keeps only summary index', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));
    await seedMemoryRoot(baizeRoot);
    const attachment = await uploadAttachment({
      fileName: 'ocr.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-png').toString('base64')
    }, { baizeRoot });

    const remembered = await rememberAttachment(attachment.id, {
      category: 'project',
      clientAnalysis: {
        provider: 'local_claude_code',
        summary: '图片里是一段需求说明。',
        memoryCategory: 'project',
        shouldRemember: true,
        reason: '需求说明需要保留。',
        extractedText: 'OCR_ONLY_TEXT_SHOULD_BE_DEEP'
      }
    }, { baizeRoot });
    const shallow = await fs.readFile(path.join(baizeRoot, 'memory', 'shallow', 'project.md'), 'utf8');
    const deepIndex = await fs.readFile(path.join(baizeRoot, 'memory', 'deep', 'indexes', 'project-index.md'), 'utf8');
    const analysisPath = path.join(baizeRoot, 'memory', 'deep', 'attachments', attachment.id, 'analysis.md');
    const deepAnalysis = await fs.readFile(analysisPath, 'utf8');

    expect(remembered.memory.status).toBe('remembered');
    expect(remembered.memory.deepAnalysisFile).toBe(analysisPath);
    expect(shallow).toContain('图片里是一段需求说明。');
    expect(shallow).toContain('深层记忆');
    expect(shallow).not.toContain('OCR_ONLY_TEXT_SHOULD_BE_DEEP');
    expect(deepIndex).toContain('analysis.md');
    expect(deepAnalysis).toContain('OCR_ONLY_TEXT_SHOULD_BE_DEEP');
    expect(deepAnalysis).toContain('ocr.png');
    await expect(fs.access(path.join(baizeRoot, 'memory', 'deep', 'attachments', attachment.id, 'ocr.png'))).resolves.toBeUndefined();
  });

  it('uses remember-time client image analysis and strips local secrets from memory', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));
    await seedMemoryRoot(baizeRoot);
    const attachment = await uploadAttachment({
      fileName: 'remember-time.png',
      mimeType: 'image/png',
      contentBase64: Buffer.from('fake-png').toString('base64')
    }, { baizeRoot });

    const remembered = await rememberAttachment(attachment.id, {
      category: 'project',
      clientAnalysis: {
        provider: 'local_claude_code',
        summary: '点击加入记忆区时完成了视觉分析。',
        memoryCategory: 'project',
        shouldRemember: true,
        reason: '图片包含记忆卡状态。',
        extractedText: 'REMEMBER_TIME_OCR_ONLY_DEEP',
        localPath: 'D:/secret/remember-time.png',
        token: 'secret-token',
        apiKey: 'secret-api-key'
      }
    }, { baizeRoot });
    const metadataText = await fs.readFile(path.join(baizeRoot, 'uploads', attachment.id, 'metadata.json'), 'utf8');
    const shallow = await fs.readFile(path.join(baizeRoot, 'memory', 'shallow', 'project.md'), 'utf8');
    const deepAnalysis = await fs.readFile(path.join(baizeRoot, 'memory', 'deep', 'attachments', attachment.id, 'analysis.md'), 'utf8');

    expect(remembered.analysis.summary).toBe('点击加入记忆区时完成了视觉分析。');
    expect(shallow).toContain('点击加入记忆区时完成了视觉分析。');
    expect(shallow).not.toContain('REMEMBER_TIME_OCR_ONLY_DEEP');
    expect(deepAnalysis).toContain('REMEMBER_TIME_OCR_ONLY_DEEP');
    expect(metadataText).not.toContain('D:/secret');
    expect(metadataText).not.toContain('secret-token');
    expect(deepAnalysis).not.toContain('secret-api-key');
  });

  it('rejects oversized uploads', async () => {
    const baizeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baize-attachments-'));

    await expect(uploadAttachment({
      fileName: 'large.txt',
      contentBase64: Buffer.alloc(50 * 1024 * 1024 + 1).toString('base64')
    }, { baizeRoot })).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', statusCode: 413 });
  });
});
