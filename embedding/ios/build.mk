# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

include  $(topsrcdir)/toolkit/mozapps/installer/package-name.mk

installer:
	@$(MAKE) -C embedding/ios/installer installer

package:
	@$(MAKE) -C embedding/ios/installer

package-compare:

stage-package:

sdk:

install::

clean::

distclean::

source-package::

upload::

source-upload::

hg-bundle::

l10n-check::
