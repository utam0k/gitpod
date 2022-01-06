// Copyright (c) 2022 Gitpod GmbH. All rights reserved.
// Licensed under the GNU Affero General Public License (AGPL).
// See License-AGPL.txt in the project root for license information.

package wsmanager

import (
	"fmt"

	"github.com/gitpod-io/gitpod/installer/pkg/common"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

func clusterRole(ctx *common.RenderContext) ([]runtime.Object, error) {
	labels := common.DefaultLabels(Component)

	return []runtime.Object{
		&rbacv1.ClusterRole{
			TypeMeta: common.TypeMetaClusterRole,
			ObjectMeta: metav1.ObjectMeta{
				Name:   fmt.Sprintf("%v-ns-%v", Component, ctx.Namespace),
				Labels: labels,
			},
			Rules: []rbacv1.PolicyRule{
				{
					APIGroups: []string{""},
					Resources: []string{
						"nodes",
					},
					Verbs: []string{
						"get",
						"list",
						"update",
						"watch",
					},
				},
			},
		},
	}, nil
}
