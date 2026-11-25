export interface TabNavigationProvider {
  readonly contentFinder?: () => void;
  setNextTabActive(): void;
  setPreviousTabActive(): void;
  setTabActiveIndex(index: number): void;
  closeActiveTab(): void;
  reopenClosedTab?(): void;
  canRenameActiveTab?(): boolean;
  renameActiveTab?(): void;
  focusActiveContent?(): void;
}
