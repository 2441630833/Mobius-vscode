/*---------------------------------------------------------------------------------------------
 *  Mobius — drag and drop from the file explorer into Continue chat
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from '../../../../base/browser/dnd.js';
import { addDisposableListener, DragAndDropObserver, EventType, getWindows, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CodeDataTransfers, containsDragType, extractEditorsDropData } from '../../../../platform/dnd/browser/dnd.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ChatViewId } from '../../chat/browser/chat.js';

export { ChatViewId as CONTINUE_CHAT_VIEW_ID };

export interface ContinueChatDroppedFile {
	path: string;
	title: string;
	isFolder: boolean;
}

let activeDropZone: HTMLElement | undefined;
let overlayCommandService: ICommandService | undefined;
let overlayVisible = false;

export function setContinueChatDropZone(element: HTMLElement | undefined): IDisposable {
	const previous = activeDropZone;
	activeDropZone = element;
	return {
		dispose() {
			if (activeDropZone === element) {
				activeDropZone = previous;
			}
		}
	};
}

function isDropZoneUnderPoint(x: number, y: number): boolean {
	if (!activeDropZone) {
		return false;
	}
	const rect = activeDropZone.getBoundingClientRect();
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isContinueChatFileDropSupported(e: DragEvent): boolean {
	if (!e.dataTransfer) {
		return false;
	}
	return containsDragType(e, DataTransfers.FILES, CodeDataTransfers.EDITORS, CodeDataTransfers.FILES, DataTransfers.RESOURCES);
}

function setDropOverlayVisible(show: boolean): void {
	if (overlayVisible === show) {
		return;
	}
	overlayVisible = show;
	overlayCommandService?.executeCommand('continue.setFileDropOverlay', show);
}

function updateDropOverlayForDragEvent(e: DragEvent): void {
	const show = isContinueChatFileDropSupported(e) && isDropZoneUnderPoint(e.clientX, e.clientY);
	setDropOverlayVisible(show);
}

function extractDroppedFilePaths(e: DragEvent): string[] {
	if (!e.dataTransfer) {
		return [];
	}
	const paths: string[] = [];
	const seen = new Set<string>();

	const addPath = (filePath: string | undefined) => {
		if (!filePath || seen.has(filePath)) {
			return;
		}
		seen.add(filePath);
		paths.push(filePath);
	};

	// Explorer sets CodeDataTransfers.FILES directly (highest priority)
	const rawCodeFiles = e.dataTransfer.getData(CodeDataTransfers.FILES);
	if (rawCodeFiles) {
		try {
			for (const filePath of JSON.parse(rawCodeFiles) as string[]) {
				addPath(filePath);
			}
		} catch {
			// ignore
		}
	}

	for (const editor of extractEditorsDropData(e)) {
		addPath(editor.resource?.fsPath);
	}

	return paths;
}

async function handleDrop(e: DragEvent, commandService: ICommandService, fileService: IFileService): Promise<boolean> {
	setDropOverlayVisible(false);

	if (!isDropZoneUnderPoint(e.clientX, e.clientY)) {
		return false;
	}

	const filePaths = extractDroppedFilePaths(e);
	if (filePaths.length === 0) {
		return false;
	}

	e.preventDefault();
	e.stopPropagation();
	e.stopImmediatePropagation();

	const files: ContinueChatDroppedFile[] = [];
	for (const filePath of filePaths) {
		const uri = URI.file(filePath);
		let isFolder = false;
		try {
			const stat = await fileService.stat(uri);
			isFolder = stat.isDirectory;
		} catch {
			// fall through — treat as file
		}
		files.push({ path: filePath, title: basename(uri), isFolder });
	}

	console.info('[Continue DnD] forwarding files to chat:', files.map(f => f.path));
	commandService.executeCommand('continue.continueGUIView.focus');
	commandService.executeCommand('continue.dropFilesToChat', files);
	return true;
}

/**
 * Wire an element so that dragging files from the VS Code explorer onto it
 * will be intercepted at the workbench level (where the CodeFiles data is
 * readable) and forwarded into the Continue chat input.
 */
export function registerContinueChatFileDropTarget(
	target: HTMLElement,
	viewId: string,
	commandService: ICommandService,
	fileService: IFileService,
): IDisposable {
	if (viewId !== ChatViewId) {
		return { dispose() { } };
	}

	const store = new DisposableStore();

	store.add(setContinueChatDropZone(target));
	overlayCommandService = commandService;
	store.add({
		dispose() {
			if (overlayCommandService === commandService) {
				overlayCommandService = undefined;
				setDropOverlayVisible(false);
			}
		}
	});

	const onDragOver = (e: DragEvent) => {
		if (!isContinueChatFileDropSupported(e)) {
			setDropOverlayVisible(false);
			return;
		}
		updateDropOverlayForDragEvent(e);
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'copy';
		}
	};

	const onDrop = (e: DragEvent) => {
		setDropOverlayVisible(false);
		void handleDrop(e, commandService, fileService);
	};

	const onDragEnd = () => {
		setDropOverlayVisible(false);
	};

	store.add(new DragAndDropObserver(target, {
		onDragOver,
		onDrop,
		onDragEnd,
	}));

	store.add(addDisposableListener(target, EventType.DRAG_OVER, onDragOver, true));
	store.add(addDisposableListener(target, EventType.DROP, onDrop, true));
	store.add(addDisposableListener(target, EventType.DRAG_END, onDragEnd, true));

	const onWindowDragOver = (ev: DragEvent) => {
		if (!isContinueChatFileDropSupported(ev)) {
			setDropOverlayVisible(false);
			return;
		}
		if (!isDropZoneUnderPoint(ev.clientX, ev.clientY)) {
			setDropOverlayVisible(false);
			return;
		}
		updateDropOverlayForDragEvent(ev);
		ev.preventDefault();
		if (ev.dataTransfer) {
			ev.dataTransfer.dropEffect = 'copy';
		}
	};

	const onWindowDrop = (ev: DragEvent) => {
		setDropOverlayVisible(false);
		void handleDrop(ev, commandService, fileService);
	};

	const registerOnWindow = (w: Window) => {
		store.add(addDisposableListener(w, EventType.DRAG_OVER, onWindowDragOver, true));
		store.add(addDisposableListener(w, EventType.DROP, onWindowDrop, true));
		store.add(addDisposableListener(w, EventType.DRAG_END, onDragEnd, true));
	};

	for (const { window: w } of getWindows()) {
		registerOnWindow(w);
	}
	store.add(onDidRegisterWindow(({ window: w }) => {
		registerOnWindow(w);
	}));

	return store;
}
