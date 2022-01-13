// Copyright (c) 2022 Gitpod GmbH. All rights reserved.
// Licensed under the GNU Affero General Public License (AGPL).
// See License-AGPL.txt in the project root for license information.

package manager

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-logr/logr"
	"golang.org/x/xerrors"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

type changeSource string

const (
	wsDaemonChange       changeSource = "ws-daemon"
	registryFacadeChange changeSource = "registry-facade"

	readyForWorkspaces = "gitpod.io/ready_for_workspaces_ns_%v"
)

// NodeLabelReconciler reconciles node labels using details about ws-daemon and registry-facade pods
type NodeLabelReconciler struct {
	client.Client
	Log    logr.Logger
	Scheme *runtime.Scheme

	podToNodeMap map[string]string
}

func NewNodeLabelReconciler(client client.Client, log logr.Logger, scheme *runtime.Scheme) *NodeLabelReconciler {
	return &NodeLabelReconciler{
		Client: client,
		Log:    log,
		Scheme: scheme,

		podToNodeMap: make(map[string]string),
	}
}
func (r *NodeLabelReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	if strings.HasPrefix(req.Name, "ws-daemon") {
		return r.sync(ctx, req, wsDaemonChange)
	}

	if strings.HasPrefix(req.Name, "registry-facade") {
		return r.sync(ctx, req, registryFacadeChange)
	}

	return ctrl.Result{}, nil
}

func (r *NodeLabelReconciler) sync(ctx context.Context, req ctrl.Request, source changeSource) (ctrl.Result, error) {
	log := ctrl.LoggerFrom(ctx)

	var pod corev1.Pod
	err := r.Client.Get(context.Background(), req.NamespacedName, &pod)
	if err != nil {
		if errors.IsNotFound(err) {
			nodeName, exists := r.podToNodeMap[req.Name]
			if !exists {
				return reconcile.Result{}, nil
			}

			err := r.removeLabelToNode(nodeName, req.Namespace)
			if err != nil {
				log.Error(err, "unexpected error removing node label", nodeName)
				return reconcile.Result{Requeue: true}, err
			}

			delete(r.podToNodeMap, req.Name)
			return reconcile.Result{}, nil
		}

		return reconcile.Result{}, err
	}

	// node where the pod is running
	nodeName := pod.Spec.NodeName
	if nodeName == "" {
		// pod not scheduled (yet)
		return reconcile.Result{}, nil
	}

	// pod is being deleted.
	if !pod.DeletionTimestamp.IsZero() {
		nodeName, exists := r.podToNodeMap[req.Name]
		if !exists {
			return reconcile.Result{}, nil
		}

		err := r.removeLabelToNode(nodeName, req.Namespace)
		if err != nil {
			log.Error(err, "unexpected error removing node label", nodeName)
			return reconcile.Result{Requeue: true}, err
		}

		delete(r.podToNodeMap, req.Name)
		return reconcile.Result{}, nil
	}

	err = r.addLabelToNode(nodeName, req.Namespace)
	if err != nil {
		log.Error(err, "unexpected error adding node label", nodeName)
		return reconcile.Result{Requeue: true}, err
	}

	r.podToNodeMap[req.Name] = nodeName

	return reconcile.Result{}, nil
}
func (r *NodeLabelReconciler) addLabelToNode(nodeName, namespace string) error {
	var node corev1.Node
	err := r.Client.Get(context.Background(), types.NamespacedName{Name: nodeName}, &node)
	if err != nil {
		return err
	}

	label := fmt.Sprintf(readyForWorkspaces, namespace)
	if _, exists := node.GetLabels()[label]; exists {
		return nil
	}

	uNode := node.DeepCopy()
	uNode.Labels[label] = "true"

	err = retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		return r.Client.Update(context.Background(), uNode)
	})

	return err
}

func (r *NodeLabelReconciler) removeLabelToNode(nodeName, namespace string) error {
	var node corev1.Node
	err := r.Client.Get(context.Background(), types.NamespacedName{Name: nodeName}, &node)
	if err != nil {
		return err
	}

	label := fmt.Sprintf(readyForWorkspaces, namespace)
	if _, exists := node.GetLabels()[label]; !exists {
		return nil
	}

	uNode := node.DeepCopy()
	delete(uNode.Labels, label)

	err = retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		return r.Client.Update(context.Background(), uNode)
	})

	return err
}

// SetupWithManager sets up the controller with the Manager.
func (r *NodeLabelReconciler) SetupWithManager(namespace string, mgr ctrl.Manager) error {
	wsDaemonSelector, err := predicate.LabelSelectorPredicate(metav1.LabelSelector{
		MatchLabels: map[string]string{"component": "ws-daemon"},
	})
	if err != nil {
		return xerrors.Errorf("unable to build a ws-daemon predicate: %w", err)
	}

	registryFacadeSelector, err := predicate.LabelSelectorPredicate(metav1.LabelSelector{
		MatchLabels: map[string]string{"component": "registry-facade"},
	})
	if err != nil {
		return xerrors.Errorf("unable to build a registry-facade predicate: %w", err)
	}

	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1.Pod{}).
		WithEventFilter(
			predicate.And(
				r.namespacePredicate(namespace),
				predicate.Or(
					wsDaemonSelector,
					registryFacadeSelector,
				),
			),
		).
		Complete(r)
}

func (r *NodeLabelReconciler) namespacePredicate(targetNamespace string) predicate.Funcs {
	return predicate.Funcs{
		GenericFunc: func(e event.GenericEvent) bool {
			r.Log.Info("Object", "namespace", e.Object.GetNamespace())
			return e.Object.GetNamespace() == targetNamespace
		},
		UpdateFunc: func(e event.UpdateEvent) bool {
			r.Log.Info("Object", "namespace", e.ObjectNew.GetNamespace())
			return e.ObjectOld.GetNamespace() == targetNamespace &&
				e.ObjectNew.GetNamespace() == targetNamespace &&
				isReady(e.ObjectNew)
		},
		CreateFunc: func(e event.CreateEvent) bool {
			return false
		},
		DeleteFunc: func(e event.DeleteEvent) bool {
			return e.Object.GetNamespace() == targetNamespace
		},
	}
}

func isReady(obj runtime.Object) bool {
	pod := obj.(*corev1.Pod)

	for _, cond := range pod.Status.Conditions {
		if cond.Type == corev1.PodReady {
			return cond.Status == corev1.ConditionTrue
		}
	}

	return false
}
