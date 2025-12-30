import { 
    App, 
    Plugin, 
    WorkspaceLeaf, 
    ItemView, 
    MarkdownView, 
    TFile, 
    MarkdownRenderer,
    Component
} from 'obsidian';

const VIEW_TYPE_GAME = "mess-up-game-view";

type Difficulty = 'easy' | 'medium' | 'hard';

const DIFFICULTY_CONFIG = {
    easy: { prefillPercent: 0.7, intruders: 1, label: "Easy" },
    medium: { prefillPercent: 0.4, intruders: 3, label: "Medium" },
    hard: { prefillPercent: 0.1, intruders: 6, label: "Hard" }
};

interface GameItem {
    id: string;
    text: string;
    originalHeading: string;
    originalIndex: number;
    indentation: number; 
    isListItem: boolean;
    listMarker?: string; // Captures "1.", "2.", "-", etc.
    isStatic?: boolean; 
    isSubHeading?: boolean;
    blockId?: string; 
    flexGroupId?: string; 
}

interface GameHeading {
    title: string;
    items: GameItem[];
    isRestored: boolean;
}

interface GameState {
    fileName: string;
    filePath: string;
    headings: GameHeading[];
    activeHeadingIndex: number | null;
    difficulty: Difficulty;
    slots: (GameItem | null)[]; 
    prefilledIndices: Set<number>;
    poolHeightPercent: number;
    poolItems: GameItem[]; 
}

export default class MessUpPlugin extends Plugin {
    async onload() {
        this.registerView(VIEW_TYPE_GAME, (leaf) => new MessUpGameView(leaf));

        this.addCommand({
            id: 'start-mess-up-game',
            name: 'Start game from current note',
            checkCallback: (checking: boolean) => {
                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (activeView) {
                    if (!checking) this.initGame(activeView);
                    return true;
                }
                return false;
            }
        });
    }

    async initGame(view: MarkdownView) {
        const file = view.file;
        if (!file) return;

        const content = await this.app.vault.read(file);
        const gameState = this.parseMarkdownToGame(content, file.basename, file.path);

        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({
            type: VIEW_TYPE_GAME,
            active: true,
            state: { gameState }
        });
    }

    parseMarkdownToGame(content: string, fileName: string, filePath: string): GameState {
        const lines = content.split(/\r?\n/);
        const headings: GameHeading[] = [];
        let currentHeading: GameHeading = { title: "Introduction", items: [], isRestored: false };
        
        const pushItem = (heading: GameHeading, text: string, isStatic: boolean, isSubHeading: boolean = false, blockId?: string) => {
            const indentMatch = text.match(/^(\s*)/);
            const indentation = indentMatch ? indentMatch[1].replace(/\t/g, '    ').length : 0;
            
            // Capture the specific list marker (e.g. "1.", "-", "*")
            const listMatch = text.match(/^\s*([-*+]|\d+\.)\s+/);
            const isListItem = !!listMatch;
            const listMarker = listMatch ? listMatch[1] : undefined;

            heading.items.push({
                id: `${heading.title}-${heading.items.length}-${Math.random().toString(36).substring(2, 7)}`, 
                text,
                originalHeading: heading.title,
                originalIndex: heading.items.length,
                indentation,
                isListItem,
                listMarker,
                isStatic,
                isSubHeading,
                blockId
            });
        };

        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed && line.length === 0) { i++; continue; }

            const headingMatch = line.match(/^(#+)\s+(.*)/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                if (level <= 2) {
                    if (currentHeading.items.length > 0) headings.push(currentHeading);
                    currentHeading = { title: headingMatch[2], items: [], isRestored: false };
                    i++; continue;
                } else {
                    pushItem(currentHeading, line, false, true);
                    i++; continue;
                }
            }

            if (trimmed.startsWith('|')) {
                const nextLine = lines[i+1]?.trim() || "";
                if (nextLine.match(/^\|?\s*[:\- ]+\s*\|/)) {
                    const bId = `table-${i}`;
                    pushItem(currentHeading, lines[i], true, false, bId);
                    pushItem(currentHeading, lines[i+1], true, false, bId);
                    i += 2;
                    while (i < lines.length && lines[i].trim().startsWith('|')) {
                        pushItem(currentHeading, lines[i], false, false, bId);
                        i++;
                    }
                    continue;
                }
            }

            if (trimmed.startsWith('> [!')) {
                const bId = `callout-${i}`;
                pushItem(currentHeading, line, true, false, bId);
                i++;
                while (i < lines.length && (lines[i]?.trim().startsWith('>') || lines[i]?.trim() === "")) {
                    if (lines[i]?.trim().startsWith('>')) pushItem(currentHeading, lines[i], false, false, bId);
                    else break;
                    i++;
                }
                continue;
            }

            pushItem(currentHeading, line, false);
            i++;
        }
        headings.push(currentHeading);

        // Flexible Groups Logic (preserves the feature where bullet items at same level can be swapped)
        headings.forEach(h => {
            const items = h.items;
            const parentStack: { indent: number, index: number }[] = [{ indent: -1, index: -1 }];
            let currentFlexGroupId: string | null = null;
            let lastParentIdx = -2;
            let lastIndent = -1;

            for (let j = 0; j < items.length; j++) {
                const item = items[j];
                const nextItem = items[j + 1];

                while (parentStack.length > 1 && parentStack[parentStack.length - 1].indent >= item.indentation) {
                    parentStack.pop();
                }
                const parentIdx = parentStack[parentStack.length - 1].index;

                // Only unordered lists are flexible; numbered lists must remain in order
                const isUnordered = /^\s*([-*+])\s+/.test(item.text);
                const hasChildren = nextItem && nextItem.indentation > item.indentation;
                const isStatic = item.isStatic || item.isSubHeading;

                if (!isUnordered || isStatic || hasChildren) {
                    currentFlexGroupId = null; 
                } else {
                    if (currentFlexGroupId === null || parentIdx !== lastParentIdx || item.indentation !== lastIndent) {
                        currentFlexGroupId = `flex-${h.title}-${j}-${Math.random().toString(36).substring(2, 5)}`;
                    }
                    item.flexGroupId = currentFlexGroupId;
                }

                if (hasChildren) {
                    parentStack.push({ indent: item.indentation, index: j });
                }
                lastParentIdx = parentIdx;
                lastIndent = item.indentation;
            }
        });

        return { 
            fileName, filePath, headings, 
            activeHeadingIndex: null, difficulty: 'medium', 
            slots: [], prefilledIndices: new Set(),
            poolHeightPercent: 30,
            poolItems: []
        };
    }
}

class MessUpGameView extends ItemView {
    state: GameState | null = null;
    selectedPill: GameItem | null = null;
    private component: Component;
    private renderCache: Map<string, string> = new Map(); 

    constructor(leaf: WorkspaceLeaf) { 
        super(leaf); 
        this.component = new Component();
    }
    
    getViewType() { return VIEW_TYPE_GAME; }
    getDisplayText() { return "Mess Up Game"; }
    getIcon() { return "dice"; }

    async onOpen() {
        this.component.load();
    }

    async onClose() {
        this.component.unload();
        this.renderCache.clear();
    }

    async setState(state: any, result: any) {
        if (state.gameState) {
            this.state = state.gameState;
            if (Array.isArray(this.state!.prefilledIndices)) {
                this.state!.prefilledIndices = new Set(this.state!.prefilledIndices);
            }
            this.render();
        }
        return super.setState(state, result);
    }

    getState() {
        const state = super.getState();
        if (this.state) {
            state.gameState = {
                ...this.state,
                prefilledIndices: Array.from(this.state.prefilledIndices) 
            };
        }
        return state;
    }

    startSession(index: number) {
        if (!this.state) return;
        const heading = this.state.headings[index];
        const config = DIFFICULTY_CONFIG[this.state.difficulty];
        
        const playableIndices = heading.items
            .map((item, idx) => item.isStatic ? -1 : idx)
            .filter(idx => idx !== -1);

        const weightedItems = playableIndices.map(idx => {
            const item = heading.items[idx];
            let stabilityScore = item.isSubHeading ? 999 : (100 / ( (item.indentation / 4) + 1 )) + (Math.random() * 20);
            return { idx, stabilityScore };
        });

        weightedItems.sort((a, b) => b.stabilityScore - a.stabilityScore);
        const numToPrefill = Math.floor(playableIndices.length * config.prefillPercent);
        const prefilledSet = new Set(weightedItems.slice(0, numToPrefill).map(item => item.idx));

        this.state.activeHeadingIndex = index;
        this.state.prefilledIndices = prefilledSet;
        this.state.slots = new Array(heading.items.length).fill(null);
        
        heading.items.forEach((item, idx) => {
            if (item.isStatic || prefilledSet.has(idx)) {
                this.state!.slots[idx] = item;
            }
        });

        const itemsInSlots = new Set(this.state.slots.filter(s => s !== null).map(s => s!.id));
        const intruders: GameItem[] = [];
        const otherHeadings = this.state.headings.filter((_, i) => i !== index);
        
        if (otherHeadings.length > 0) {
            for (let i = 0; i < config.intruders; i++) {
                const randomH = otherHeadings[Math.floor(Math.random() * otherHeadings.length)];
                if (randomH && randomH.items.length > 0) {
                    const randomI = randomH.items[Math.floor(Math.random() * randomH.items.length)];
                    if (!randomI.isStatic) intruders.push(randomI);
                }
            }
        }

        this.state.poolItems = [
            ...heading.items.filter(item => !item.isStatic && !itemsInSlots.has(item.id)),
            ...intruders
        ].sort(() => Math.random() - 0.5);

        this.render();
    }

    isSlotCorrect(itemInSlot: GameItem | null, originalIndex: number, heading: GameHeading): boolean {
        if (!itemInSlot) return false;
        const originalItemAtThisSlot = heading.items[originalIndex];
        if (itemInSlot.originalIndex === originalIndex && itemInSlot.originalHeading === heading.title) return true;
        if (originalItemAtThisSlot.flexGroupId && itemInSlot.flexGroupId === originalItemAtThisSlot.flexGroupId) return true;
        return false;
    }

    isBlockFullyRestored(blockId: string, heading: GameHeading, slots: (GameItem | null)[]): boolean {
        const blockIndices = heading.items
            .map((item, idx) => item.blockId === blockId ? idx : -1)
            .filter(idx => idx !== -1);
        return blockIndices.every(idx => this.isSlotCorrect(slots[idx], idx, heading));
    }

    async getRenderedHTML(text: string, isFullBlock: boolean): Promise<string> {
        const cacheKey = `${isFullBlock ? 'B' : 'F'}-${text}`;
        if (this.renderCache.has(cacheKey)) return this.renderCache.get(cacheKey)!;

        const temp = document.createElement('div');
        if (isFullBlock) {
            await MarkdownRenderer.render(this.app, text, temp, this.state?.filePath || "", this.component);
        } else {
            // Strip markers for individual fragments to prevent double-rendering markers
            const cleanText = text.replace(/^\s*([-*+]|\d+\.)\s+/, '');
            await MarkdownRenderer.render(this.app, cleanText, temp, this.state?.filePath || "", this.component);
            const p = temp.querySelector('p');
            if (p) temp.innerHTML = p.innerHTML;
        }
        
        const html = temp.innerHTML;
        this.renderCache.set(cacheKey, html);
        return html;
    }

    async render() {
        const container = this.containerEl.children[1] as HTMLElement;
        const docScrollTop = container.querySelector('.document-scroll-area')?.scrollTop || 0;
        const poolScrollTop = container.querySelector('.pool-wrapper')?.scrollTop || 0;

        container.empty();
        container.addClass('mess-up-game-root');
        this.addStyles();

        if (!this.state) return;
        if (this.state.activeHeadingIndex === null) {
            this.renderLobby(container);
        } else {
            await this.renderRepairSession(container);
        }
        
        const scrollArea = container.querySelector('.document-scroll-area');
        if (scrollArea) scrollArea.scrollTop = docScrollTop;
        const poolArea = container.querySelector('.pool-wrapper');
        if (poolArea) poolArea.scrollTop = poolScrollTop;
    }

    renderLobby(parent: HTMLElement) {
        const lobby = parent.createDiv({ cls: "lobby-container" });
        lobby.createEl("h2", { text: `Source: ${this.state!.fileName}` });
        
        const diffContainer = lobby.createDiv({ cls: "difficulty-selector" });
        (Object.keys(DIFFICULTY_CONFIG) as Difficulty[]).forEach(d => {
            const btn = diffContainer.createEl("button", { 
                text: DIFFICULTY_CONFIG[d].label,
                cls: this.state!.difficulty === d ? "is-active" : ""
            });
            btn.onclick = () => { this.state!.difficulty = d; this.render(); };
        });

        const list = lobby.createDiv({ cls: "heading-grid" });
        this.state!.headings.forEach((h, index) => {
            const card = list.createDiv({ cls: `heading-card ${h.isRestored ? 'restored' : ''}` });
            card.createEl("h3", { text: h.title });
            const count = h.items.filter(i => !i.isStatic).length;
            card.createEl("span", { text: `${count} fragments` });
            
            if (h.isRestored) {
                card.createDiv({ cls: "status-badge", text: "✓ RESTORED" });
            } else {
                card.onclick = () => this.startSession(index);
            }
        });
    }

    async renderRepairSession(parent: HTMLElement) {
        const state = this.state!;
        const activeIdx = state.activeHeadingIndex!;
        const heading = state.headings[activeIdx];

        const topBar = parent.createDiv({ cls: "game-top-bar" });
        const leftGroup = topBar.createDiv({ cls: "bar-group" });
        leftGroup.createEl("button", { text: "← Back", cls: "mod-warning" }).onclick = () => {
            state.activeHeadingIndex = null;
            this.render();
        };
        leftGroup.createEl("h3", { text: heading.title, cls: "current-title" });

        const rightGroup = topBar.createDiv({ cls: "bar-group resizer-group" });
        rightGroup.createSpan({ text: "Pool Size: " });
        const resizer = rightGroup.createEl("input", { type: "range", value: state.poolHeightPercent.toString() });
        resizer.setAttr("min", "10"); resizer.setAttr("max", "80");
        resizer.oninput = (e) => {
            const val = (e.target as HTMLInputElement).value;
            state.poolHeightPercent = parseInt(val);
            (parent.querySelector('.pool-wrapper') as HTMLElement).style.height = `${val}vh`;
        };

        const itemsInSlots = new Set(state.slots.filter(s => s !== null).map(s => s!.id));
        const currentPool = state.poolItems.filter(item => !itemsInSlots.has(item.id));

        const poolWrapper = parent.createDiv({ cls: "pool-wrapper" });
        poolWrapper.style.height = `${state.poolHeightPercent}vh`;
        const poolRow = poolWrapper.createDiv({ cls: "pool-grid" });
        
        await Promise.all(currentPool.map(async (item) => {
            const isSelected = this.selectedPill?.id === item.id;
            const pill = poolRow.createDiv({ cls: `game-pill ${isSelected ? 'selected' : ''} ${item.isSubHeading ? 'is-subheading' : ''}` });
            
            // Show marker in pool pill
            if (item.listMarker) {
                pill.createSpan({ cls: "pill-marker", text: `${item.listMarker} ` });
            }
            const contentSpan = pill.createSpan();
            contentSpan.innerHTML = await this.getRenderedHTML(item.text, false);
            
            pill.onclick = (e) => {
                e.stopPropagation();
                this.selectedPill = isSelected ? null : item;
                this.render();
            };
        }));

        const docScrollArea = parent.createDiv({ cls: "document-scroll-area" });
        const docContainer = docScrollArea.createDiv({ cls: "document-view" });
        const processedBlockIds = new Set<string>();

        for (let idx = 0; idx < state.slots.length; idx++) {
            const originalItem = heading.items[idx];
            const itemInSlot = state.slots[idx];

            if (originalItem.blockId) {
                if (processedBlockIds.has(originalItem.blockId)) continue;
                if (this.isBlockFullyRestored(originalItem.blockId, heading, state.slots)) {
                    const blockItems = heading.items.filter(i => i.blockId === originalItem.blockId);
                    const fullText = blockItems.map(i => i.text).join('\n');
                    const blockRow = docContainer.createDiv({ cls: "doc-row restored-block-clean" });
                    blockRow.innerHTML = await this.getRenderedHTML(fullText, true);
                    processedBlockIds.add(originalItem.blockId);
                    continue;
                }
            }

            const row = docContainer.createDiv({ cls: "doc-row" });
            row.style.paddingLeft = `${(itemInSlot?.indentation ?? originalItem.indentation) * 12}px`;

            if (itemInSlot) {
                const isCorrect = this.isSlotCorrect(itemInSlot, idx, heading);
                const isLocked = state.prefilledIndices.has(idx) || itemInSlot.isStatic;
                const itemEl = row.createDiv({ 
                    cls: `rendered-item ${isLocked ? 'locked' : (isCorrect ? 'correct' : 'wrong')} ${itemInSlot.isSubHeading ? 'is-subheading' : ''}`,
                });
                
                // Render the specific marker (numbered or bullet)
                if (itemInSlot.listMarker) {
                    itemEl.createSpan({ cls: "item-marker", text: `${itemInSlot.listMarker} ` });
                }

                const contentSpan = itemEl.createSpan();
                contentSpan.innerHTML = await this.getRenderedHTML(itemInSlot.text, false);
                
                if (!isLocked) itemEl.onclick = () => { state.slots[idx] = null; this.render(); };
            } else {
                const dropZone = row.createDiv({ 
                    cls: `markdown-drop-zone ${this.selectedPill ? 'active-target' : ''} ${originalItem.isSubHeading ? 'is-subheading-zone' : ''}` 
                });
                
                // Show the required marker as a structural hint
                if (originalItem.listMarker) {
                    dropZone.createSpan({ cls: "structure-hint", text: `${originalItem.listMarker} ` });
                }

                dropZone.createSpan({ text: this.selectedPill ? "Place..." : "..." });
                dropZone.onclick = () => {
                    if (this.selectedPill) {
                        state.slots[idx] = this.selectedPill;
                        this.selectedPill = null;
                        this.checkWinCondition(heading);
                        this.render();
                    }
                };
            }
        }
    }

    checkWinCondition(heading: GameHeading) {
        const state = this.state!;
        const isPerfect = state.slots.every((item, idx) => this.isSlotCorrect(item, idx, heading));
        if (isPerfect) {
            heading.isRestored = true;
            setTimeout(() => { 
                state.activeHeadingIndex = null; 
                this.render(); 
            }, 1000);
        }
    }

    addStyles() {
        const id = "mess-up-styles";
        if (document.getElementById(id)) return;
        const style = document.createElement("style");
        style.id = id;
        style.innerHTML = `
            .mess-up-game-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; background: var(--background-primary); }
            .game-top-bar { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 8px 15px; background: var(--background-secondary); border-bottom: 1px solid var(--background-modifier-border); }
            .bar-group { display: flex; align-items: center; gap: 12px; }
            .resizer-group { font-size: 0.8em; color: var(--text-faint); }
            .pool-wrapper { flex-shrink: 0; background: var(--background-primary); border-bottom: 2px solid var(--interactive-accent); padding: 15px; overflow-y: auto; }
            .pool-grid { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
            .game-pill { padding: 4px 10px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 4px; cursor: pointer; font-size: 0.85em; max-width: 300px; display: flex; align-items: flex-start; }
            .game-pill.is-subheading { border-color: var(--text-accent); font-weight: bold; }
            .game-pill.selected { background: var(--interactive-accent); color: white; border-color: var(--interactive-accent); }
            .document-scroll-area { flex-grow: 1; overflow-y: auto; padding: 20px; }
            .document-view { max-width: 700px; margin: 0 auto; }
            .doc-row { margin-bottom: 4px; }
            .rendered-item { padding: 4px 8px; border-radius: 4px; border-left: 3px solid transparent; cursor: pointer; display: flex; align-items: flex-start; }
            .rendered-item.is-subheading { font-weight: bold; font-size: 1.1em; color: var(--text-accent); }
            
            .item-marker, .pill-marker, .structure-hint { 
                color: var(--text-faint); 
                margin-right: 8px; 
                white-space: nowrap;
                font-family: var(--font-monospace);
                font-weight: bold;
            }

            .rendered-item.correct { border-left-color: var(--text-success); background: var(--background-secondary); }
            .rendered-item.wrong { border-left-color: var(--text-error); background: rgba(var(--text-error-rgb), 0.1); }
            .rendered-item.locked { border-left-color: var(--background-modifier-border); opacity: 0.7; cursor: default; }
            .markdown-drop-zone { background: var(--background-secondary-alt); border: 1px dashed var(--background-modifier-border); padding: 4px 8px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; min-height: 30px; }
            .markdown-drop-zone.active-target { border-color: var(--interactive-accent); background: var(--background-primary-alt); }
            .is-subheading-zone { border-width: 2px; height: 40px; }
            
            .restored-block-clean { margin: 12px 0; border: none; background: transparent; }
            .lobby-container { padding: 40px; max-width: 800px; margin: 0 auto; }
            .difficulty-selector { margin-bottom: 20px; display: flex; gap: 8px; }
            .difficulty-selector button.is-active { background: var(--interactive-accent); color: white; }
            .heading-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 15px; }
            .heading-card { border: 1px solid var(--background-modifier-border); padding: 15px; border-radius: 8px; cursor: pointer; background: var(--background-secondary); position: relative; transition: transform 0.1s ease; }
            .heading-card:hover { transform: translateY(-2px); border-color: var(--interactive-accent); }
            .heading-card.restored { border-color: var(--text-success); opacity: 0.8; }
            .status-badge { position: absolute; top: 10px; right: 10px; font-size: 0.7em; color: var(--text-success); font-weight: bold; }
        `;
        document.head.appendChild(style);
    }
}