"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.Mangler = void 0;
const fs = require("fs");
const path = require("path");
const process_1 = require("process");
const source_map_1 = require("source-map");
const ts = require("typescript");
const url_1 = require("url");
const workerpool = require("workerpool");
const staticLanguageServiceHost_1 = require("./staticLanguageServiceHost");
const buildfile = require('../../../src/buildfile');
class ShortIdent {
    prefix;
    static _keywords = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
        'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
        'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw',
        'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);
    static _alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890$_'.split('');
    _value = 0;
    constructor(prefix) {
        this.prefix = prefix;
    }
    next(isNameTaken) {
        const candidate = this.prefix + ShortIdent.convert(this._value);
        this._value++;
        if (ShortIdent._keywords.has(candidate) || /^[_0-9]/.test(candidate) || isNameTaken?.(candidate)) {
            // try again
            return this.next(isNameTaken);
        }
        return candidate;
    }
    static convert(n) {
        const base = this._alphabet.length;
        let result = '';
        do {
            const rest = n % base;
            result += this._alphabet[rest];
            n = (n / base) | 0;
        } while (n > 0);
        return result;
    }
}
var FieldType;
(function (FieldType) {
    FieldType[FieldType["Public"] = 0] = "Public";
    FieldType[FieldType["Protected"] = 1] = "Protected";
    FieldType[FieldType["Private"] = 2] = "Private";
})(FieldType || (FieldType = {}));
class ClassData {
    fileName;
    node;
    fields = new Map();
    replacements;
    parent;
    children;
    constructor(fileName, node) {
        // analyse all fields (properties and methods). Find usages of all protected and
        // private ones and keep track of all public ones (to prevent naming collisions)
        this.fileName = fileName;
        this.node = node;
        const candidates = [];
        for (const member of node.members) {
            if (ts.isMethodDeclaration(member)) {
                // method `foo() {}`
                candidates.push(member);
            }
            else if (ts.isPropertyDeclaration(member)) {
                // property `foo = 234`
                candidates.push(member);
            }
            else if (ts.isGetAccessor(member)) {
                // getter: `get foo() { ... }`
                candidates.push(member);
            }
            else if (ts.isSetAccessor(member)) {
                // setter: `set foo() { ... }`
                candidates.push(member);
            }
            else if (ts.isConstructorDeclaration(member)) {
                // constructor-prop:`constructor(private foo) {}`
                for (const param of member.parameters) {
                    if (hasModifier(param, ts.SyntaxKind.PrivateKeyword)
                        || hasModifier(param, ts.SyntaxKind.ProtectedKeyword)
                        || hasModifier(param, ts.SyntaxKind.PublicKeyword)
                        || hasModifier(param, ts.SyntaxKind.ReadonlyKeyword)) {
                        candidates.push(param);
                    }
                }
            }
        }
        for (const member of candidates) {
            const ident = ClassData._getMemberName(member);
            if (!ident) {
                continue;
            }
            const type = ClassData._getFieldType(member);
            this.fields.set(ident, { type, pos: member.name.getStart() });
        }
    }
    static _getMemberName(node) {
        if (!node.name) {
            return undefined;
        }
        const { name } = node;
        let ident = name.getText();
        if (name.kind === ts.SyntaxKind.ComputedPropertyName) {
            if (name.expression.kind !== ts.SyntaxKind.StringLiteral) {
                // unsupported: [Symbol.foo] or [abc + 'field']
                return;
            }
            // ['foo']
            ident = name.expression.getText().slice(1, -1);
        }
        return ident;
    }
    static _getFieldType(node) {
        if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) {
            return 2 /* FieldType.Private */;
        }
        else if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) {
            return 1 /* FieldType.Protected */;
        }
        else {
            return 0 /* FieldType.Public */;
        }
    }
    static _shouldMangle(type) {
        return type === 2 /* FieldType.Private */
            || type === 1 /* FieldType.Protected */;
    }
    static makeImplicitPublicActuallyPublic(data, reportViolation) {
        // TS-HACK
        // A subtype can make an inherited protected field public. To prevent accidential
        // mangling of public fields we mark the original (protected) fields as public...
        for (const [name, info] of data.fields) {
            if (info.type !== 0 /* FieldType.Public */) {
                continue;
            }
            let parent = data.parent;
            while (parent) {
                if (parent.fields.get(name)?.type === 1 /* FieldType.Protected */) {
                    const parentPos = parent.node.getSourceFile().getLineAndCharacterOfPosition(parent.fields.get(name).pos);
                    const infoPos = data.node.getSourceFile().getLineAndCharacterOfPosition(info.pos);
                    reportViolation(name, `'${name}' from ${parent.fileName}:${parentPos.line + 1}`, `${data.fileName}:${infoPos.line + 1}`);
                    parent.fields.get(name).type = 0 /* FieldType.Public */;
                }
                parent = parent.parent;
            }
        }
    }
    static fillInReplacement(data) {
        if (data.replacements) {
            // already done
            return;
        }
        // fill in parents first
        if (data.parent) {
            ClassData.fillInReplacement(data.parent);
        }
        data.replacements = new Map();
        const isNameTaken = (name) => {
            // locally taken
            if (data._isNameTaken(name)) {
                return true;
            }
            // parents
            let parent = data.parent;
            while (parent) {
                if (parent._isNameTaken(name)) {
                    return true;
                }
                parent = parent.parent;
            }
            // children
            if (data.children) {
                const stack = [...data.children];
                while (stack.length) {
                    const node = stack.pop();
                    if (node._isNameTaken(name)) {
                        return true;
                    }
                    if (node.children) {
                        stack.push(...node.children);
                    }
                }
            }
            return false;
        };
        const identPool = new ShortIdent('');
        for (const [name, info] of data.fields) {
            if (ClassData._shouldMangle(info.type)) {
                const shortName = identPool.next(isNameTaken);
                data.replacements.set(name, shortName);
            }
        }
    }
    // a name is taken when a field that doesn't get mangled exists or
    // when the name is already in use for replacement
    _isNameTaken(name) {
        if (this.fields.has(name) && !ClassData._shouldMangle(this.fields.get(name).type)) {
            // public field
            return true;
        }
        if (this.replacements) {
            for (const shortName of this.replacements.values()) {
                if (shortName === name) {
                    // replaced already (happens wih super types)
                    return true;
                }
            }
        }
        if (isNameTakenInFile(this.node, name)) {
            return true;
        }
        return false;
    }
    lookupShortName(name) {
        let value = this.replacements.get(name);
        let parent = this.parent;
        while (parent) {
            if (parent.replacements.has(name) && parent.fields.get(name)?.type === 1 /* FieldType.Protected */) {
                value = parent.replacements.get(name) ?? value;
            }
            parent = parent.parent;
        }
        return value;
    }
    // --- parent chaining
    addChild(child) {
        this.children ??= [];
        this.children.push(child);
        child.parent = this;
    }
}
function isNameTakenInFile(node, name) {
    const identifiers = node.getSourceFile().identifiers;
    if (identifiers instanceof Map) {
        if (identifiers.has(name)) {
            return true;
        }
    }
    return false;
}
const fileIdents = new class {
    idents = new ShortIdent('$');
    next(file) {
        return this.idents.next(name => isNameTakenInFile(file, name));
    }
};
const skippedExportMangledFiles = [
    // Build
    'css.build',
    'nls.build',
    // Monaco
    'editorCommon',
    'editorOptions',
    'editorZoom',
    'standaloneEditor',
    'standaloneLanguages',
    // Generated
    'extensionsApiProposals',
    // Module passed around as type
    'pfs',
    // entry points
    ...[
        buildfile.entrypoint('vs/workbench/workbench.desktop.main', []),
        buildfile.base,
        buildfile.workerExtensionHost,
        buildfile.workerNotebook,
        buildfile.workerLanguageDetection,
        buildfile.workerLocalFileSearch,
        buildfile.workerProfileAnalysis,
        buildfile.workbenchDesktop,
        buildfile.workbenchWeb,
        buildfile.code
    ].flat().map(x => x.name),
];
const skippedExportMangledProjects = [
    // This uses webpack to dynamically rewrite imports, which messes up our mangling
    'microsoft-authentication',
];
class DeclarationData {
    fileName;
    node;
    replacementName;
    constructor(fileName, node) {
        this.fileName = fileName;
        this.node = node;
        this.replacementName = fileIdents.next(node.getSourceFile());
    }
    get locations() {
        return [{
                fileName: this.fileName,
                offset: this.node.name.getStart()
            }];
    }
    shouldMangle(newName) {
        // New name is longer the existing one :'(
        if (newName.length >= this.node.name.getText().length) {
            return false;
        }
        // Don't mangle functions we've explicitly opted out
        if (this.node.getFullText().includes('@skipMangle')) {
            return false;
        }
        return true;
    }
}
class ConstData {
    fileName;
    statement;
    decl;
    service;
    replacementName;
    constructor(fileName, statement, decl, service) {
        this.fileName = fileName;
        this.statement = statement;
        this.decl = decl;
        this.service = service;
        this.replacementName = fileIdents.next(statement.getSourceFile());
    }
    get locations() {
        // If the const aliases any types, we need to rename those too
        const definitionResult = this.service.getDefinitionAndBoundSpan(this.decl.getSourceFile().fileName, this.decl.name.getStart());
        if (definitionResult?.definitions && definitionResult.definitions.length > 1) {
            return definitionResult.definitions.map(x => ({ fileName: x.fileName, offset: x.textSpan.start }));
        }
        return [{ fileName: this.fileName, offset: this.decl.name.getStart() }];
    }
    shouldMangle(newName) {
        // New name is longer the existing one :'(
        if (newName.length >= this.decl.name.getText().length) {
            return false;
        }
        // Don't mangle functions we've explicitly opted out
        if (this.statement.getFullText().includes('@skipMangle')) {
            return false;
        }
        return true;
    }
}
/**
 * TypeScript2TypeScript transformer that mangles all private and protected fields
 *
 * 1. Collect all class fields (properties, methods)
 * 2. Collect all sub and super-type relations between classes
 * 3. Compute replacement names for each field
 * 4. Lookup rename locations for these fields
 * 5. Prepare and apply edits
 */
class Mangler {
    projectPath;
    log;
    allClassDataByKey = new Map();
    allExportsByKey = new Map();
    service;
    renameWorkerPool;
    constructor(projectPath, log = () => { }) {
        this.projectPath = projectPath;
        this.log = log;
        this.service = ts.createLanguageService(new staticLanguageServiceHost_1.StaticLanguageServiceHost(projectPath));
        this.renameWorkerPool = workerpool.pool(path.join(__dirname, 'renameWorker.js'), {
            maxWorkers: 2,
            minWorkers: 'max'
        });
    }
    async computeNewFileContents(strictImplicitPublicHandling) {
        // STEP: Find all classes and their field info. Find exported symbols.
        const visit = (node) => {
            if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
                const anchor = node.name ?? node;
                const key = `${node.getSourceFile().fileName}|${anchor.getStart()}`;
                if (this.allClassDataByKey.has(key)) {
                    throw new Error('DUPE?');
                }
                this.allClassDataByKey.set(key, new ClassData(node.getSourceFile().fileName, node));
            }
            if ((
            // Exported class
            ts.isClassDeclaration(node)
                && hasModifier(node, ts.SyntaxKind.ExportKeyword)
                && node.name) || (
            // Or exported function
            ts.isFunctionDeclaration(node)
                && ts.isSourceFile(node.parent)
                && hasModifier(node, ts.SyntaxKind.ExportKeyword)
                && node.name && node.body // On named function and not on the overload
            )) {
                const anchor = node.name;
                const key = `${node.getSourceFile().fileName}|${anchor.getStart()}`;
                if (this.allExportsByKey.has(key)) {
                    throw new Error('DUPE?');
                }
                this.allExportsByKey.set(key, new DeclarationData(node.getSourceFile().fileName, node));
            }
            // Exported variable
            if (ts.isVariableStatement(node)
                && ts.isSourceFile(node.parent)
                && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
                for (const decl of node.declarationList.declarations) {
                    const key = `${decl.getSourceFile().fileName}|${decl.name.getStart()}`;
                    if (this.allExportsByKey.has(key)) {
                        throw new Error('DUPE?');
                    }
                    this.allExportsByKey.set(key, new ConstData(node.getSourceFile().fileName, node, decl, this.service));
                }
            }
            ts.forEachChild(node, visit);
        };
        for (const file of this.service.getProgram().getSourceFiles()) {
            if (!file.isDeclarationFile) {
                ts.forEachChild(file, visit);
            }
        }
        this.log(`Done collecting. Classes: ${this.allClassDataByKey.size}. Exported const/fn: ${this.allExportsByKey.size}`);
        //  STEP: connect sub and super-types
        const setupParents = (data) => {
            const extendsClause = data.node.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
            if (!extendsClause) {
                // no EXTENDS-clause
                return;
            }
            const info = this.service.getDefinitionAtPosition(data.fileName, extendsClause.types[0].expression.getEnd());
            if (!info || info.length === 0) {
                // throw new Error('SUPER type not found');
                return;
            }
            if (info.length !== 1) {
                // inherits from declared/library type
                return;
            }
            const [definition] = info;
            const key = `${definition.fileName}|${definition.textSpan.start}`;
            const parent = this.allClassDataByKey.get(key);
            if (!parent) {
                // throw new Error(`SUPER type not found: ${key}`);
                return;
            }
            parent.addChild(data);
        };
        for (const data of this.allClassDataByKey.values()) {
            setupParents(data);
        }
        //  STEP: make implicit public (actually protected) field really public
        const violations = new Map();
        let violationsCauseFailure = false;
        for (const data of this.allClassDataByKey.values()) {
            ClassData.makeImplicitPublicActuallyPublic(data, (name, what, why) => {
                const arr = violations.get(what);
                if (arr) {
                    arr.push(why);
                }
                else {
                    violations.set(what, [why]);
                }
                if (strictImplicitPublicHandling && !strictImplicitPublicHandling.has(name)) {
                    violationsCauseFailure = true;
                }
            });
        }
        for (const [why, whys] of violations) {
            this.log(`WARN: ${why} became PUBLIC because of: ${whys.join(' , ')}`);
        }
        if (violationsCauseFailure) {
            const message = 'Protected fields have been made PUBLIC. This hurts minification and is therefore not allowed. Review the WARN messages further above';
            this.log(`ERROR: ${message}`);
            throw new Error(message);
        }
        // STEP: compute replacement names for each class
        for (const data of this.allClassDataByKey.values()) {
            ClassData.fillInReplacement(data);
        }
        this.log(`Done creating class replacements`);
        // STEP: prepare rename edits
        this.log(`Starting prepare rename edits`);
        const editsByFile = new Map();
        const appendEdit = (fileName, edit) => {
            const edits = editsByFile.get(fileName);
            if (!edits) {
                editsByFile.set(fileName, [edit]);
            }
            else {
                edits.push(edit);
            }
        };
        const appendRename = (newText, loc) => {
            appendEdit(loc.fileName, {
                newText: (loc.prefixText || '') + newText + (loc.suffixText || ''),
                offset: loc.textSpan.start,
                length: loc.textSpan.length
            });
        };
        const renameResults = [];
        const queueRename = (fileName, pos, newName) => {
            renameResults.push(Promise.resolve(this.renameWorkerPool.exec('findRenameLocations', [this.projectPath, fileName, pos]))
                .then((locations) => ({ newName, locations })));
        };
        for (const data of this.allClassDataByKey.values()) {
            if (hasModifier(data.node, ts.SyntaxKind.DeclareKeyword)) {
                continue;
            }
            fields: for (const [name, info] of data.fields) {
                if (!ClassData._shouldMangle(info.type)) {
                    continue fields;
                }
                // TS-HACK: protected became public via 'some' child
                // and because of that we might need to ignore this now
                let parent = data.parent;
                while (parent) {
                    if (parent.fields.get(name)?.type === 0 /* FieldType.Public */) {
                        continue fields;
                    }
                    parent = parent.parent;
                }
                const newName = data.lookupShortName(name);
                queueRename(data.fileName, info.pos, newName);
            }
        }
        for (const data of this.allExportsByKey.values()) {
            if (data.fileName.endsWith('.d.ts')
                || skippedExportMangledProjects.some(proj => data.fileName.includes(proj))
                || skippedExportMangledFiles.some(file => data.fileName.endsWith(file + '.ts'))) {
                continue;
            }
            if (!data.shouldMangle(data.replacementName)) {
                continue;
            }
            const newText = data.replacementName;
            for (const { fileName, offset } of data.locations) {
                queueRename(fileName, offset, newText);
            }
        }
        await Promise.all(renameResults).then((result) => {
            for (const { newName, locations } of result) {
                for (const loc of locations) {
                    appendRename(newName, loc);
                }
            }
        });
        await this.renameWorkerPool.terminate();
        this.log(`Done preparing edits: ${editsByFile.size} files`);
        // STEP: apply all rename edits (per file)
        const result = new Map();
        let savedBytes = 0;
        for (const item of this.service.getProgram().getSourceFiles()) {
            const { mapRoot, sourceRoot } = this.service.getProgram().getCompilerOptions();
            const projectDir = path.dirname(this.projectPath);
            const sourceMapRoot = mapRoot ?? (0, url_1.pathToFileURL)(sourceRoot ?? projectDir).toString();
            // source maps
            let generator;
            let newFullText;
            const edits = editsByFile.get(item.fileName);
            if (!edits) {
                // just copy
                newFullText = item.getFullText();
            }
            else {
                // source map generator
                const relativeFileName = normalize(path.relative(projectDir, item.fileName));
                const mappingsByLine = new Map();
                // apply renames
                edits.sort((a, b) => b.offset - a.offset);
                const characters = item.getFullText().split('');
                let lastEdit;
                for (const edit of edits) {
                    if (lastEdit && lastEdit.offset === edit.offset) {
                        //
                        if (lastEdit.length !== edit.length || lastEdit.newText !== edit.newText) {
                            this.log('ERROR: Overlapping edit', item.fileName, edit.offset, edits);
                            throw new Error('OVERLAPPING edit');
                        }
                        else {
                            continue;
                        }
                    }
                    lastEdit = edit;
                    const mangledName = characters.splice(edit.offset, edit.length, edit.newText).join('');
                    savedBytes += mangledName.length - edit.newText.length;
                    // source maps
                    const pos = item.getLineAndCharacterOfPosition(edit.offset);
                    let mappings = mappingsByLine.get(pos.line);
                    if (!mappings) {
                        mappings = [];
                        mappingsByLine.set(pos.line, mappings);
                    }
                    mappings.unshift({
                        source: relativeFileName,
                        original: { line: pos.line + 1, column: pos.character },
                        generated: { line: pos.line + 1, column: pos.character },
                        name: mangledName
                    }, {
                        source: relativeFileName,
                        original: { line: pos.line + 1, column: pos.character + edit.length },
                        generated: { line: pos.line + 1, column: pos.character + edit.newText.length },
                    });
                }
                // source map generation, make sure to get mappings per line correct
                generator = new source_map_1.SourceMapGenerator({ file: path.basename(item.fileName), sourceRoot: sourceMapRoot });
                generator.setSourceContent(relativeFileName, item.getFullText());
                for (const [, mappings] of mappingsByLine) {
                    let lineDelta = 0;
                    for (const mapping of mappings) {
                        generator.addMapping({
                            ...mapping,
                            generated: { line: mapping.generated.line, column: mapping.generated.column - lineDelta }
                        });
                        lineDelta += mapping.original.column - mapping.generated.column;
                    }
                }
                newFullText = characters.join('');
            }
            result.set(item.fileName, { out: newFullText, sourceMap: generator?.toString() });
        }
        this.log(`Done: ${savedBytes / 1000}kb saved`);
        return result;
    }
}
exports.Mangler = Mangler;
// --- ast utils
function hasModifier(node, kind) {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(modifiers?.find(mode => mode.kind === kind));
}
function normalize(path) {
    return path.replace(/\\/g, '/');
}
async function _run() {
    const projectPath = path.join(__dirname, '../../../src/tsconfig.json');
    const projectBase = path.dirname(projectPath);
    const newProjectBase = path.join(path.dirname(projectBase), path.basename(projectBase) + '2');
    fs.cpSync(projectBase, newProjectBase, { recursive: true });
    const mangler = new Mangler(projectPath, console.log);
    for (const [fileName, contents] of await mangler.computeNewFileContents(new Set(['saveState']))) {
        const newFilePath = path.join(newProjectBase, path.relative(projectBase, fileName));
        await fs.promises.mkdir(path.dirname(newFilePath), { recursive: true });
        await fs.promises.writeFile(newFilePath, contents.out);
        if (contents.sourceMap) {
            await fs.promises.writeFile(newFilePath + '.map', contents.sourceMap);
        }
    }
}
if (__filename === process_1.argv[1]) {
    _run();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7OztnR0FHZ0c7OztBQUVoRyx5QkFBeUI7QUFDekIsNkJBQTZCO0FBQzdCLHFDQUErQjtBQUMvQiwyQ0FBeUQ7QUFDekQsaUNBQWlDO0FBQ2pDLDZCQUFvQztBQUNwQyx5Q0FBeUM7QUFDekMsMkVBQXdFO0FBQ3hFLE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0FBRXBELE1BQU0sVUFBVTtJQVlHO0lBVlYsTUFBTSxDQUFDLFNBQVMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxVQUFVO1FBQzlHLFNBQVMsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxJQUFJO1FBQ25HLFFBQVEsRUFBRSxJQUFJLEVBQUUsWUFBWSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsT0FBTztRQUMxRyxNQUFNLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztJQUU1RCxNQUFNLENBQUMsU0FBUyxHQUFHLGtFQUFrRSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUVoRyxNQUFNLEdBQUcsQ0FBQyxDQUFDO0lBRW5CLFlBQ2tCLE1BQWM7UUFBZCxXQUFNLEdBQU4sTUFBTSxDQUFRO0lBQzVCLENBQUM7SUFFTCxJQUFJLENBQUMsV0FBc0M7UUFDMUMs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