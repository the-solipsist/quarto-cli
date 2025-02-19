/*
 * devcontainer.ts
 *
 * Copyright (C) 2021-2022 Posit Software, PBC
 */

import { extname } from "path/mod.ts";
import { existsSync } from "fs/mod.ts";
import { projectType } from "../project/types/project-types.ts";
import {
  kManuscriptType,
  ResolvedManuscriptConfig,
} from "../project/types/manuscript/manuscript-types.ts";
import { isPdfOutput } from "../config/format.ts";
import { ProjectContext } from "../project/types.ts";
import { kLocalDevelopment, quartoConfig } from "../core/quarto.ts";
import { SemVer } from "semver/mod.ts";

export interface ProjectEnvironment {
  title: string;
  tools: Array<QuartoTool>;
  codeEnvironment: QuartoEditor;
  engines: string[];
  quarto: QuartoVersion;
  environments: string[];
  openFiles: string[];
  envVars: Record<string, string>;
}

export type QuartoEditor = "vscode" | "rstudio" | "jupyterlab";
export type QuartoVersion = "release" | "prerelease" | SemVer;
export type QuartoTool = "tinytex" | "chromium";

const kDefaultContainerTitle = "Default Container";

export const computeProjectEnvironment = async (
  context: ProjectContext,
) => {
  // Get the quarto version
  const version = quartoConfig.version();
  const quarto = version === kLocalDevelopment
    ? "prerelease"
    : new SemVer(version);

  const containerCtx: ProjectEnvironment = {
    title: kDefaultContainerTitle,
    engines: context.engines,
    tools: [],
    codeEnvironment: "vscode",
    quarto,
    environments: [],
    openFiles: [],
    envVars: {},
  };

  // Figure out the editor
  const editorContext = projectEditor(context);
  containerCtx.codeEnvironment = editorContext.editor;
  containerCtx.openFiles.push(...editorContext.openFiles);

  // Determine the title
  const title = context.config?.project.title;
  if (title) {
    containerCtx.title = title;
  }

  // Determine what tools (if any) we should also install
  const tools = await projectTools(context);
  containerCtx.tools.push(...tools);

  // Determine environments
  const envFiles = Object.keys(environmentCommands);
  for (const envFile of envFiles) {
    if (existsSync(envFile)) {
      containerCtx.environments.push(envFile);
    }
  }

  return containerCtx;
};

interface EnvironmentOptions {
  restore?: string;
  features?: Record<string, Record<string, unknown>>;
}

const environmentCommands: Record<string, EnvironmentOptions> = {
  // TODO: this needs to happen in correct directory post setup
  // options(repos = c(REPO_NAME = "https://packagemanager.posit.co/cran/__linux__/jammy/latest"))
  "renv.lock": {
    restore: `Rscript -e 'renv::restore();'`,
  },
  "requirements.txt": {
    restore: `python3 -m pip install -r requirements.txt`,
  },
  "DESCRIPTION": {
    restore: `Rscript -e 'devtools::install_local(getwd())'`,
  },
  "install.R": {
    restore: `Rscript install.R`,
  },
  "environment.yml": {
    restore: "conda env create -f environment.yml",
    features: {
      "ghcr.io/devcontainers/features/conda:1": {
        addCondaForge: true,
      },
    },
  },
  "PipFile": {},
  "PipFile.lock": {},
  "setup.py": {},
  "Project.toml": {},
  "REQUIRE": {},
};

// Regex used to determine whether file contents will require the installation of Chromium
const kChromiumHint = /````*{mermaid}|{dot}/gm;

const projectTools = async (context: ProjectContext) => {
  // Determine what tools (if any) we should also install
  let tinytex = false;
  let chromium = false;

  for (const input of context.files.input) {
    if (!tinytex) {
      // If we haven't yet found the need for tinytex,
      // go ahead and look for PDF format. Once a single
      // file needs, it we can stop looking
      const formats = await context.renderFormats(input, "all", context);

      const hasPdf = Object.values(formats).some((format) => {
        return isPdfOutput(format.pandoc);
      });
      tinytex = hasPdf;
    }

    // See if the file contains mermaid or graphviZ
    if (!chromium) {
      const contents = Deno.readTextFileSync(input);
      if (contents.match(kChromiumHint)) {
        chromium = true;
      }
    }

    if (tinytex && chromium) {
      break;
    }
  }

  const tools: QuartoTool[] = [];
  if (tinytex) {
    tools.push("tinytex");
  }
  if (chromium) {
    tools.push("chromium");
  }
  return tools;
};

const projectEditor = (context: ProjectContext) => {
  const qmdCodeTool = context.engines.includes("knitr") ? "rstudio" : "vscode";
  const ipynbCodeTool = "jupyterlab";

  const openFiles: string[] = [];
  let editor: QuartoEditor = qmdCodeTool;

  // Determine the code environment
  // Special case manuscripts - the root article will drive the code environment
  if (projectType(context.config?.project.type).type === kManuscriptType) {
    // Choose the code environment based upon the engine and article file type
    const manuscriptConfig = context.config
      ?.[kManuscriptType] as ResolvedManuscriptConfig;
    if (extname(manuscriptConfig.article) === ".qmd") {
      editor = qmdCodeTool;
    } else {
      editor = ipynbCodeTool;
    }

    // Open the main article file
    openFiles.push(manuscriptConfig.article);
  } else {
    // Count the ipynb vs qmds and use that as guideline
    const exts: Record<string, number> = {};
    const inputs = context.files.input;
    for (const input of inputs) {
      const ext = extname(input);
      exts[ext] = (exts[ext] || 0) + 1;
    }

    const qmdCount = exts[".qmd"] || 0;
    const ipynbCount = exts[".ipynb"] || 0;
    if (qmdCount >= ipynbCount) {
      editor = qmdCodeTool;
    } else {
      editor = ipynbCodeTool;
    }
  }
  return {
    editor,
    openFiles,
  };
};
