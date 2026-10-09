export {};
declare global {
  interface Window {
    storyflowDesktop?: {
      getState(): Promise<DesktopUpdateState>;
      update(): Promise<DesktopUpdateState>;
      chooseWorkspace(): Promise<void>;
      onState(callback: (state: DesktopUpdateState) => void): () => void;
    };
  }
  interface DesktopUpdateState {
    phase:
      | "idle"
      | "development"
      | "checking"
      | "downloading"
      | "waiting"
      | "installing"
      | "current"
      | "error";
    version: string;
    nextVersion?: string;
    percent: number;
    message: string;
    workspace: string;
  }
}
