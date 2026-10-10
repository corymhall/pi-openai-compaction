import { TypeScriptProject } from '@hallcor/pulumi-projen-project-types';
import { NodePackageManager } from 'projen/lib/javascript';
const project = new TypeScriptProject({
  defaultReleaseBranch: 'main',
  devDeps: ['@hallcor/pulumi-projen-project-types'],
  name: 'pi-openai-compaction',
  packageManager: NodePackageManager.NPM,
  projenrcTs: true,
  deps: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    'openai',
  ],

  // deps: [],                /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // packageName: undefined,  /* The "name" in package.json. */
});
project.synth();
