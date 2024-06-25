import {
	App, getLinkpath, MarkdownPostProcessorContext, MarkdownRenderChild, TFile,
	parseFrontMatterAliases
} from "obsidian";

import { LinkerPluginSettings } from "../main";
import { LinkerCache, PrefixTree } from "./linkerCache";

class GlossaryFile {
	name: string;
	file: TFile;
	aliases: string[];

	constructor(file: TFile, aliases: string[] = []) {
		this.file = file;
		this.name = file.basename;
		this.aliases = aliases;
	}
}

export class GlossaryLinker extends MarkdownRenderChild {
	text: string;
	ctx: MarkdownPostProcessorContext;
	app: App;
	settings: LinkerPluginSettings;
	linkerCache: LinkerCache;

	glossaryFiles: GlossaryFile[] = [];

	constructor(app: App, settings: LinkerPluginSettings, context: MarkdownPostProcessorContext, containerEl: HTMLElement) {
		super(containerEl);
		this.settings = settings;
		this.app = app;
		this.ctx = context;

		this.linkerCache = new LinkerCache(app, settings);

		this.glossaryFiles = this.getGlossaryFiles();

		// TODO: Fix this?
		// If not called, sometimes (especially for lists) elements are added to the context after they already have been loaded
		// within the parent element. This causes the already added links to be removed...?
		this.load();
	}

	getGlossaryFiles(): GlossaryFile[] {
		const includeAllFiles = this.settings.includeAllFiles || this.settings.linkerDirectories.length === 0;
		const includeDirPattern = new RegExp(`(^|\/)(${this.settings.linkerDirectories.join("|")})\/`);
		const files = this.app.vault.getMarkdownFiles().filter((file) => {
			if (includeAllFiles) return true;
			return includeDirPattern.test(file.path) && this.ctx.sourcePath != file.path
		});

		let gFiles = files.map((file) => {
			let aliases = parseFrontMatterAliases(this.app.metadataCache.getFileCache(file)?.frontmatter)
			return new GlossaryFile(file, aliases ? aliases : []);
		});

		// Sort the files by their name length
		return gFiles.sort((a, b) => b.name.length - a.name.length);
	}

	getClosestLinkPath(glossaryName: string): TFile | null {
		const destName = this.ctx.sourcePath.replace(/(.*).md/, "$1");
		let currentDestName = destName;

		let currentPath = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(glossaryName), currentDestName);

		if (currentPath == null) return null;

		while (currentDestName.includes("/")) {
			currentDestName = currentDestName.replace(/\/[^\/]*?$/, "");

			const newPath = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(glossaryName), currentDestName);

			if ((newPath?.path?.length || 0) > currentPath?.path?.length) {
				currentPath = newPath;
				console.log("Break at New path: ", currentPath);
				break;
			}
		}

		return currentPath;
	}

	onload() {
		// return;
		const tags = ["p", "li", "td", "th", "span", "em", "strong"]; //"div"
		if (this.settings.includeHeaders) {
			tags.push("h1", "h2", "h3", "h4", "h5", "h6");
		}

		for (const tag of tags) {
			// console.log("Tag: ", tag);
			const nodeList = this.containerEl.getElementsByTagName(tag);
			const children = this.containerEl.children;
			// if (nodeList.length === 0) continue;
			// if (nodeList.length != 0) console.log(tag, nodeList.length);
			for (let index = 0; index <= nodeList.length; index++) {
				const item = index == nodeList.length ? this.containerEl : nodeList.item(index)!;

				for (let childNodeIndex = 0; childNodeIndex < item.childNodes.length; childNodeIndex++) {
					const childNode = item.childNodes[childNodeIndex];

					if (childNode.nodeType === Node.TEXT_NODE) {
						let text = childNode.textContent || "";
						if (text.length === 0) continue;

						this.linkerCache.reset();

						const additions: { id: number, from: number, to: number, text: string, file: TFile, isSubWord: boolean }[] = [];

						let id = 0;
						// Iterate over every char in the text
						for (let i = 0; i <= text.length; i) {
							// Do this to get unicode characters as whole chars and not only half of them
							const codePoint = text.codePointAt(i)!;
							const char = i < text.length ? String.fromCodePoint(codePoint) : "\n";

							// If we are at a word boundary, get the current fitting files
							const isWordBoundary = PrefixTree.checkWordBoundary(char);
							if (!this.settings.matchOnlyWholeWords || isWordBoundary) {
								const currentNodes = this.linkerCache.cache.getCurrentMatchNodes(i);
								if (currentNodes.length > 0) {

									// TODO: Handle multiple matches
									const node = currentNodes[0];
									const nFrom = node.start;
									const nTo = node.end;
									const name = text.slice(nFrom, nTo);

									// TODO: Handle multiple files
									const file = node.files.values().next().value;

									additions.push({
										id: id++,
										from: nFrom,
										to: nTo,
										text: name,
										file: file,
										isSubWord: !isWordBoundary
									});
								}
							}

							// Push the char to get the next nodes in the prefix tree
							this.linkerCache.cache.pushChar(char);
							i += char.length;
						}

						// Sort additions by from position
						additions.sort((a, b) => {
							if (a.from === b.from) {
								return b.to - a.to;
							}
							return a.from - b.from
						});

						// Delete additions that overlap
						// Additions are sorted by from position and after that by length, we want to keep longer additions
						const filteredAdditions = [];
						const additionsToDelete: Map<number, boolean> = new Map();
						for (let i = 0; i < additions.length; i++) {
							const addition = additions[i];
							for (let j = i + 1; j < additions.length; j++) {
								const otherAddition = additions[j];
								if (otherAddition.from >= addition.to) {
									break;
								}

								additionsToDelete.set(otherAddition.id, true);
							}
						}

						for (const addition of additions) {
							if (!additionsToDelete.has(addition.id)) {
								filteredAdditions.push(addition);
							}
						}

						const parent = childNode.parentElement;
						let lastTo = 0;
						// console.log("Parent: ", parent);

						for (let addition of filteredAdditions) {
							// get linkpath
							const destName = this.ctx.sourcePath.replace(/(.*).md/, "$1");
							// const destName = this.ctx.sourcePath;

							// const linkpath = this.getClosestLinkPath(glossaryEntryName);
							const linkpath = addition.file.path;

							const replacementText = addition.text;
							// console.log("Replacement text: ", replacementText);

							// create link
							let span = document.createElement("span");
							span.classList.add("glossary-entry", "virtual-link");
							if (this.settings.applyDefaultLinkStyling) {
								span.classList.add("virtual-link-default");
							}

							let link = this.containerEl.createEl("a");
							// let el = document.createElement("a");
							link.text = `${replacementText}`; // + this.settings.glossarySuffix;
							link.href = `${linkpath}`;
							// el.setAttribute("data-href", glossaryEntryName);
							link.setAttribute("data-href", `${linkpath}`);
							link.classList.add("internal-link");
							// link.classList.add("glossary-entry");
							link.classList.add("virtual-link-a");						

							link.target = "_blank";
							link.rel = "noopener";

							span.appendChild(link);

							if ((this.settings.glossarySuffix?.length ?? 0) > 0) {
								if ((this.settings.glossarySuffix?.length ?? 0) > 0) {
									if (!addition.isSubWord || !this.settings.suppressSuffixForSubWords) {
										let icon = document.createElement("sup");
										icon.textContent = this.settings.glossarySuffix;
										icon.classList.add("linker-suffix-icon");

										span.appendChild(icon);
									}
								}
							}

							if (addition.from > 0) {
								parent?.insertBefore(document.createTextNode(text.slice(lastTo, addition.from)), childNode);
							}


							parent?.insertBefore(span, childNode);

							lastTo = addition.to;
						}
						const textLength = text.length;
						if (lastTo < textLength) {
							parent?.insertBefore(document.createTextNode(text.slice(lastTo)), childNode);
						}
						parent?.removeChild(childNode);
						childNodeIndex += 1;
					}
				}
			}
		}
	}
}



